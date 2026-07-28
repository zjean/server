// Mock the config singleton before anything imports UserModel (which reads it
// at module load). Tests mutate `configuration.applications.files.versions.*`
// per case — vi.mock returns a stable reference, and VersioningService captures
// that nested object, so mutations are visible to an already-constructed
// service.
vi.mock('../../../configuration/config.environment', () => ({
  configuration: {
    applications: {
      files: {
        dataPath: '',
        usersPath: '',
        spacesPath: '',
        tmpPath: '',
        versions: {
          enabled: true,
          maxVersionsPerFile: 20,
          retentionDays: { users: false, spaces: false },
          quotaShare: 0.5,
          minIntervalSeconds: 60,
          // Present in the mock ON PURPOSE, with the real defaults. A mock that
          // omitted it would send every origin down the scalar fallback, so no
          // test would ever exercise the per-origin lookup — the same shape of
          // gap as the retention spec whose db stub always answered "no quota".
          minIntervalSecondsByOrigin: { collabora: 300, onlyoffice: 300 }
        }
      }
    }
  },
  serverConfig: {},
  exportConfiguration: vi.fn()
}))

import { Logger } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Mock } from 'vitest'
import { configuration } from '../../../configuration/config.environment'
import { FileRowEnsurer } from '../../custom-shared/services/file-row-ensurer.service'
import { FileError } from '../../files/models/file-error'
import { LockConflict } from '../../files/models/file-lock-error'
import { FilesLockManager } from '../../files/services/files-lock-manager.service'
import { FilesQueries } from '../../files/services/files-queries.service'
import { genEtag } from '../../files/utils/files'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { UserModel } from '../../users/models/user.model'
import { WebDAVFile } from '../../webdav/models/webdav-file.model'
import { VersionInsert, VersionRow } from '../interfaces/version.interface'
import { VersioningQueries } from './versioning-queries.service'
import { VersioningService } from './versioning.service'

const versionsConfig = configuration.applications.files.versions as any

// In-memory stand-in for custom_files_versions. Deliberately a real store
// rather than per-call mocks: the service's eviction loop, refcounting and
// purge all depend on reading back what they wrote, and assertions like "one
// blob for two identical versions" are meaningless against stubs.
class FakeQueries {
  rows: VersionRow[] = []
  private nextId = 1
  resolveIds: number[] = []

  async insertVersion(values: VersionInsert): Promise<number> {
    const id = this.nextId++
    this.rows.push({ createdAt: new Date(), label: null, ...values, id } as VersionRow)
    return id
  }
  async newestForTuple(fileId: number, authorId: number | null, origin: string) {
    return [...this.rows]
      .filter((r) => r.fileId === fileId && (r.authorId ?? null) === authorId && r.origin === origin)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id)[0]
  }
  async listByFileId(fileId: number) {
    return this.rows
      .filter((r) => r.fileId === fileId)
      .map((r) => ({ ...r, authorLogin: r.authorId ? 'alice' : null, authorFullName: r.authorId ? 'Alice A' : null }))
      .sort((a, b) => b.id - a.id)
  }
  async getById(id: number) {
    return this.rows.find((r) => r.id === id)
  }
  async setLabel(id: number, label: string | null) {
    const row = this.rows.find((r) => r.id === id)
    if (row) row.label = label
  }
  async deleteById(id: number) {
    this.rows = this.rows.filter((r) => r.id !== id)
  }
  async countByBlob(checksum: string, versionsRoot: string) {
    return this.rows.filter((r) => r.checksum === checksum && r.versionsRoot === versionsRoot).length
  }
  async usageByRoot(versionsRoot: string) {
    const rows = this.rows.filter((r) => r.versionsRoot === versionsRoot)
    return {
      used: rows.reduce((n, r) => n + r.size, 0),
      labeledBytes: rows.filter((r) => r.label).reduce((n, r) => n + r.size, 0),
      count: rows.length
    }
  }
  async oldestUnlabeledByRoot(versionsRoot: string) {
    return [...this.rows]
      .filter((r) => r.versionsRoot === versionsRoot && !r.label)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id)[0]
  }
  async listByFileIds(fileIds: number[]) {
    return this.rows.filter((r) => fileIds.includes(r.fileId))
  }
  async deleteByFileIds(fileIds: number[]) {
    this.rows = this.rows.filter((r) => !fileIds.includes(r.fileId))
  }
  async refreshScope() {
    this.refreshScopeCalls++
  }
  refreshScopeCalls = 0
  async resolveFileIdsForDelete() {
    return this.resolveIds
  }
}

describe(VersioningService.name, () => {
  let service: VersioningService
  let queries: FakeQueries
  let ensurer: { ensureFileId: Mock }
  let filesQueries: { getUserFileByPath: Mock; getSpaceFileId: Mock; updateFile: Mock }
  let lockManager: { create: Mock; createOrRefresh: Mock; removeLock: Mock }
  let tmpRoot: string
  let filePath: string
  let loggedErrors: Mock

  const FILE_ID = 4242
  const CONTENT = 'the content that is about to be destroyed'

  const user = { id: 7, login: 'alice', isGuest: false, isLink: false } as unknown as UserModel
  const guest = { id: 8, login: 'guesty', isGuest: true, isLink: false } as unknown as UserModel
  const linkUser = { id: 9, login: 'linky', isGuest: false, isLink: true } as unknown as UserModel

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-in-versioning-'))
    configuration.applications.files.dataPath = tmpRoot
    configuration.applications.files.usersPath = path.join(tmpRoot, 'users')
    configuration.applications.files.spacesPath = path.join(tmpRoot, 'spaces')
    configuration.applications.files.tmpPath = path.join(tmpRoot, 'tmp')

    versionsConfig.enabled = true
    versionsConfig.minIntervalSeconds = 60
    versionsConfig.minIntervalSecondsByOrigin = { collabora: 300, onlyoffice: 300 }
    versionsConfig.quotaShare = 0.5
    versionsConfig.maxVersionsPerFile = 20

    filePath = path.join(tmpRoot, 'users', 'alice', 'files', 'docs', 'report.txt')
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, CONTENT)

    // snapshotBeforeOverwrite swallows everything by design, so a bug after the
    // row insert (a missing method on a collaborator, say) shows up as a
    // logged error and otherwise-passing tests. Capturing errors lets the
    // happy-path tests assert that nothing was silently eaten — this caught a
    // real TypeError that 43 green tests had been hiding.
    loggedErrors = vi.fn()
    vi.spyOn(Logger.prototype, 'error').mockImplementation(loggedErrors)

    queries = new FakeQueries()
    ensurer = { ensureFileId: vi.fn().mockResolvedValue(FILE_ID) }
    filesQueries = {
      getUserFileByPath: vi.fn().mockResolvedValue(FILE_ID),
      getSpaceFileId: vi.fn().mockResolvedValue(FILE_ID),
      updateFile: vi.fn().mockResolvedValue(undefined)
    }
    // createOrRefresh mirrors the real manager: [true, lock] when it created one,
    // [false, existingLock] when the CALLER already held it, and a thrown
    // LockConflict when someone else does. Stubbing only `create` — which cannot
    // express the second case — is what hid the restore bug.
    lockManager = {
      create: vi.fn().mockResolvedValue([true, { key: 'lock-1' }]),
      createOrRefresh: vi.fn().mockResolvedValue([true, { key: 'lock-1' }]),
      removeLock: vi.fn().mockResolvedValue(undefined)
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        VersioningService,
        { provide: VersioningQueries, useValue: queries },
        { provide: FileRowEnsurer, useValue: ensurer },
        { provide: FilesQueries, useValue: filesQueries },
        { provide: FilesLockManager, useValue: lockManager }
      ]
    }).compile()
    moduleRef.useLogger(['fatal'])
    service = moduleRef.get(VersioningService)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  function personalSpace(overrides: Partial<SpaceEnv> = {}): SpaceEnv {
    return {
      url: 'files/personal/docs/report.txt',
      realPath: filePath,
      dbFile: { ownerId: user.id, path: 'docs/report.txt', inTrash: false },
      inPersonalSpace: true,
      inFilesRepository: true,
      inSharesRepository: false,
      inTrashRepository: false,
      envPermissions: 'a:m:d',
      storageQuota: 0,
      alias: 'personal',
      ...overrides
    } as unknown as SpaceEnv
  }

  const versionsDir = () => path.join(tmpRoot, 'users', 'alice', 'versions')

  async function blobFiles(): Promise<string[]> {
    const found: string[] = []
    async function walk(dir: string) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(p)
        } else {
          found.push(p)
        }
      }
    }
    await walk(versionsDir())
    return found
  }

  /* ------------------------------------------------------------- snapshotting */

  it('writes a blob and a row for the content about to be destroyed', async () => {
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })

    expect(queries.rows).toHaveLength(1)
    const [row] = queries.rows
    expect(row).toMatchObject({ fileId: FILE_ID, origin: 'web', authorId: user.id, label: null, size: CONTENT.length })
    expect(row.versionsRoot).toBe('user:alice')

    const blobs = await blobFiles()
    expect(blobs).toHaveLength(1)
    // The blob holds the OLD bytes, and lives under <digest[0:2]>/<digest>.
    expect(await fs.readFile(blobs[0], 'utf8')).toBe(CONTENT)
    expect(path.basename(blobs[0])).toBe(row.checksum)
    expect(path.basename(path.dirname(blobs[0]))).toBe(row.checksum.slice(0, 2))
  })

  it('stores the blob store as a sibling of files/ and trash/, never inside the served tree', async () => {
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    const [blob] = await blobFiles()
    const filesRoot = path.join(tmpRoot, 'users', 'alice', 'files')
    // The content indexer, PROPFIND and sync all walk the files root and have
    // no exclusion logic — sibling placement is the entire isolation mechanism.
    expect(blob.startsWith(filesRoot)).toBe(false)
    expect(blob.startsWith(path.join(tmpRoot, 'users', 'alice', 'versions'))).toBe(true)
  })

  /* ------------------------------------------------- WebDAV interop (task D1) */

  // A PROPFIND must be indistinguishable before and after a snapshot.
  //
  // Both props are derived purely from the live file's stat — getetag is
  // genEtag(size, mtime) (files/utils/files.ts) and getlastmodified is
  // new Date(mtime).toUTCString() — so this holds only while snapshotting
  // never touches the live file. It does not: stageBlob copies OUT of
  // space.realPath with fs.copyFile and hashes the STAGED copy, so the source
  // is opened read-only and its mtime is never rewritten.
  //
  // The failure this guards against is not hypothetical for a versioning
  // implementation: a design that `touch`ed the live file to mark it versioned,
  // or that hashed in place with an open-for-update handle, would change the
  // ETag and make every DAV and NC client re-download an unmodified file.
  it('leaves the live file’s ETag and getlastmodified untouched, so a PROPFIND cannot tell versions exist', async () => {
    const davProps = async () => {
      const stats = await fs.stat(filePath)
      const f = new WebDAVFile(
        { id: 0, name: 'report.txt', isDir: false, size: stats.size, ctime: stats.ctimeMs, mtime: stats.mtimeMs, mime: 'text-plain' } as any,
        'personal/docs'
      )
      return { etag: f.getetag, lastModified: f.getlastmodified, size: f.getcontentlength }
    }
    const before = await davProps()

    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'webdav' })

    expect(queries.rows).toHaveLength(1)
    expect(await davProps()).toEqual(before)
    // And the ETag really is a function of size+mtime alone, which is why the
    // equality above is the whole claim rather than a sample of it.
    expect(before.etag).toBe(genEtag({ size: CONTENT.length, mtime: (await fs.stat(filePath)).mtimeMs }))
  })

  // The other half of "PROPFIND is unchanged": nothing new appears INSIDE the
  // tree PROPFIND enumerates. Sibling placement is asserted structurally in
  // utils/paths.spec.ts; this asserts it against a real snapshot on a real
  // filesystem, which is the form that survives a refactor of the path helpers.
  it('adds nothing inside the served files tree, so the versions store cannot surface in a PROPFIND', async () => {
    const filesRoot = path.join(tmpRoot, 'users', 'alice', 'files')
    const listFilesTree = async () => (await fs.readdir(filesRoot, { recursive: true })).sort()
    const before = await listFilesTree()

    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'webdav' })

    expect(await blobFiles()).toHaveLength(1)
    expect(await listFilesTree()).toEqual(before)
    // The staging directory is inside the versions root, not the files root —
    // a temp dir under files/ would be PROPFINDable for the length of a copy.
    expect(await fs.readdir(versionsDir())).toContain('.staging')
  })

  // THE load-bearing property of the blob store, and the one a hardlink
  // implementation silently violates.
  //
  // Three of the seven write paths truncate the live file IN PLACE rather than
  // replacing it (saveStream's direct branch, both editors via
  // copyFileContent, and mkFile). A hardlinked blob shares the live inode, so
  // each of those writes would land on the bytes the version points at and the
  // "saved" version would end up holding the NEW content. This test reproduces
  // exactly that write shape.
  it('stores content independent of the live file: an in-place truncating write cannot corrupt it', async () => {
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    const [blob] = await blobFiles()

    // Same shape as writeFromStream/copyFileContent/createEmptyFile: flag 'w',
    // same inode, truncate in place.
    const inodeBefore = (await fs.stat(filePath)).ino
    await fs.writeFile(filePath, 'the new content that replaced it')
    expect((await fs.stat(filePath)).ino).toBe(inodeBefore)

    expect(await fs.readFile(blob, 'utf8')).toBe(CONTENT)
    expect((await fs.stat(blob)).ino).not.toBe(inodeBefore)
  })

  it('leaves no partial blob at the content-addressed path when the copy fails', async () => {
    // A truncated file at the CAS path would be trusted as complete forever by
    // the dedup existence check, so the copy stages to a .part name first.
    vi.spyOn(fs, 'copyFile').mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })

    expect(queries.rows).toHaveLength(0)
    expect(await blobFiles()).toHaveLength(0)
  })

  // The store's one invariant: a blob's filename IS the hash of the bytes under
  // it. The digest is therefore taken from the staged copy, never from the live
  // file — hashing the live file in a separate pass from the copy leaves a
  // window (WebDAV writes hold no server lock) in which the two disagree, and
  // because lookups are content-addressed a mis-named blob would then be served
  // for every later file with that content.
  it('names each blob after the hash of its own stored bytes', async () => {
    versionsConfig.minIntervalSeconds = 0
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    await fs.writeFile(filePath, 'a different revision entirely')
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })

    const blobs = await blobFiles()
    expect(blobs).toHaveLength(2)
    for (const blob of blobs) {
      const actual = crypto
        .createHash('sha512-256')
        .update(await fs.readFile(blob))
        .digest('hex')
      expect(path.basename(blob)).toBe(actual)
      // And the row agrees with the file on disk.
      expect(queries.rows.map((r) => r.checksum)).toContain(actual)
    }
    expect(loggedErrors).not.toHaveBeenCalled()
  })

  it('leaves no staging debris behind on success', async () => {
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    expect((await blobFiles()).filter((f) => f.includes('.staging'))).toHaveLength(0)
  })

  it('refreshes the denormalized scope cache after committing, as the ADR promises', async () => {
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    expect(queries.refreshScopeCalls).toBe(1)
    expect(loggedErrors).not.toHaveBeenCalled()
  })

  it('never versions a create (no live file) or a directory', async () => {
    const missing = personalSpace({ realPath: path.join(tmpRoot, 'users', 'alice', 'files', 'brand-new.txt') })
    await service.snapshotBeforeOverwrite(user, missing, { origin: 'web' })

    const dirPath = path.join(tmpRoot, 'users', 'alice', 'files', 'a-folder')
    await fs.mkdir(dirPath, { recursive: true })
    await service.snapshotBeforeOverwrite(user, personalSpace({ realPath: dirPath }), { origin: 'web' })

    expect(queries.rows).toHaveLength(0)
    expect(await blobFiles()).toHaveLength(0)
  })

  it('anchors on the id the ensurer returns, reusing it across snapshots of the same file', async () => {
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    await fs.writeFile(filePath, 'second revision')
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'webdav' })

    expect(queries.rows).toHaveLength(2)
    expect(new Set(queries.rows.map((r) => r.fileId))).toEqual(new Set([FILE_ID]))
    expect(ensurer.ensureFileId).toHaveBeenCalledTimes(2)
    // The lookup is by (in-space dir path, name) — never a URL, never absolute.
    const [, , props] = ensurer.ensureFileId.mock.calls[0]
    expect(props).toMatchObject({ path: 'docs', name: 'report.txt', isDir: false, id: 0 })
  })

  it('passes path "." for a root-level file, matching how files.path stores it', async () => {
    const rootFile = path.join(tmpRoot, 'users', 'alice', 'files', 'root.txt')
    await fs.writeFile(rootFile, 'x')
    await service.snapshotBeforeOverwrite(
      user,
      personalSpace({ realPath: rootFile, dbFile: { ownerId: user.id, path: 'root.txt', inTrash: false } as any }),
      {
        origin: 'web'
      }
    )
    const [, , props] = ensurer.ensureFileId.mock.calls[0]
    expect(props).toMatchObject({ path: '.', name: 'root.txt' })
  })

  it('skips the snapshot when the ensurer cannot resolve an id', async () => {
    ensurer.ensureFileId.mockResolvedValue(0)
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    expect(queries.rows).toHaveLength(0)
    expect(await blobFiles()).toHaveLength(0)
  })

  it('deduplicates identical content within one versions root: two rows, one blob', async () => {
    versionsConfig.minIntervalSeconds = 0
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })

    expect(queries.rows).toHaveLength(2)
    expect(queries.rows[0].checksum).toBe(queries.rows[1].checksum)
    expect(await blobFiles()).toHaveLength(1)
  })

  /* ---------------------------------------------------------------- guest/link */

  it.each([
    ['guest', () => guest],
    ['link', () => linkUser]
  ])('is a no-op for a %s user, whose home lives outside the versions root', async (_label, getUser) => {
    await service.snapshotBeforeOverwrite(getUser(), personalSpace(), { origin: 'web' })
    expect(queries.rows).toHaveLength(0)
    expect(ensurer.ensureFileId).not.toHaveBeenCalled()
  })

  /* ---------------------------------------------------------------- coalescing */

  it('coalesces a second save within the window for the same (file, author, origin)', async () => {
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'collabora' })
    await fs.writeFile(filePath, 'autosave 2')
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'collabora' })

    // The pre-session state is already captured; an editor autosaving must not
    // mint a version per save.
    expect(queries.rows).toHaveLength(1)
  })

  it('does not coalesce across a different origin or author', async () => {
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'collabora' })
    await fs.writeFile(filePath, 'via webdav')
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'webdav' })
    await fs.writeFile(filePath, 'other author')
    await service.snapshotBeforeOverwrite({ ...user, id: 99 } as UserModel, personalSpace(), { origin: 'collabora' })

    expect(queries.rows).toHaveLength(3)
  })

  it('never coalesces behind a labeled version', async () => {
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'collabora' })
    queries.rows[0].label = 'before the rewrite'
    await fs.writeFile(filePath, 'the rewrite')
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'collabora' })

    // Suppressing here would let a named revision silently swallow a real change.
    expect(queries.rows).toHaveLength(2)
  })

  // A restore's safety snapshot is the ONLY record of the pre-restore content,
  // so coalescing it would leave a second restore inside the window with
  // nothing to go back to — breaking the "a restore is never destructive"
  // promise. Restores are rare and deliberate; there is no autosave storm here.
  it('never coalesces a restore snapshot, even back-to-back', async () => {
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'restore' })
    await fs.writeFile(filePath, 'changed between restores')
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'restore' })

    expect(queries.rows.filter((r) => r.origin === 'restore')).toHaveLength(2)
  })

  it('coalescing is disabled by minIntervalSeconds = 0 for the origins the scalar governs', async () => {
    versionsConfig.minIntervalSeconds = 0
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    expect(queries.rows).toHaveLength(2)
  })

  it('takes a new version once the window has elapsed', async () => {
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'collabora' })
    // 301s: collabora's own window is 300, not the 60 the scalar carries.
    queries.rows[0].createdAt = new Date(Date.now() - 301_000)
    await fs.writeFile(filePath, 'much later')
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'collabora' })
    expect(queries.rows).toHaveLength(2)
  })

  /* ------------------------------------------- the per-origin window (ADR §5) */

  // The window is per-origin because the two kinds of writer have cadences two
  // orders of magnitude apart: an editor's is set by the document server
  // (Collabora saves after 30 idle seconds), an interactive save is a human
  // decision. One scalar cannot serve both — at 60 an hour of editing mints ~10
  // versions and, with maxVersionsPerFile at 20, evicts half the file's
  // genuinely distinct older revisions.
  describe('per-origin coalescing window', () => {
    // THE test: the same elapsed time, two origins, two answers.
    it('coalesces an editor save that an interactive save of the same age would not', async () => {
      const hundredSecondsAgo = () => new Date(Date.now() - 100_000)

      await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'collabora' })
      await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
      expect(queries.rows).toHaveLength(2)
      for (const row of queries.rows) row.createdAt = hundredSecondsAgo()

      await fs.writeFile(filePath, 'a later autosave')
      await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'collabora' })
      await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })

      // 100s < collabora's 300 -> suppressed. 100s > web's 60 -> a new version.
      expect(queries.rows.filter((r) => r.origin === 'collabora')).toHaveLength(1)
      expect(queries.rows.filter((r) => r.origin === 'web')).toHaveLength(2)
    })

    it.each(['onlyoffice', 'collabora'] as const)('gives %s the editor window rather than the scalar', async (origin) => {
      await service.snapshotBeforeOverwrite(user, personalSpace(), { origin })
      queries.rows[0].createdAt = new Date(Date.now() - 120_000)
      await fs.writeFile(filePath, 'two minutes later')
      await service.snapshotBeforeOverwrite(user, personalSpace(), { origin })

      // Two minutes is past the 60s scalar but inside the 300s editor window.
      expect(queries.rows).toHaveLength(1)
    })

    it.each(['web', 'web-patch', 'webdav', 'sync', 'sync-make', 'nc-chunked', 'nc-text'] as const)(
      'falls back to the scalar for %s, which has no override',
      async (origin) => {
        await service.snapshotBeforeOverwrite(user, personalSpace(), { origin })
        queries.rows[0].createdAt = new Date(Date.now() - 61_000)
        await fs.writeFile(filePath, 'just over a minute later')
        await service.snapshotBeforeOverwrite(user, personalSpace(), { origin })

        expect(queries.rows).toHaveLength(2)
      }
    )

    // 0 is a MEANINGFUL value, not "unset". A `?? fallback` or a truthiness
    // check would silently promote it back to the scalar's 60.
    it('treats a per-origin 0 as "never coalesce this origin", even with a non-zero scalar', async () => {
      versionsConfig.minIntervalSeconds = 60
      versionsConfig.minIntervalSecondsByOrigin = { collabora: 0, onlyoffice: 300 }

      await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'collabora' })
      await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'collabora' })

      expect(queries.rows).toHaveLength(2)
    })

    it('lets a per-origin override coalesce an origin the scalar would have released', async () => {
      versionsConfig.minIntervalSeconds = 0
      versionsConfig.minIntervalSecondsByOrigin = { collabora: 300, onlyoffice: 300 }

      await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'collabora' })
      await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'collabora' })

      // The scalar says "never coalesce"; collabora's own override still does.
      expect(queries.rows).toHaveLength(1)
    })

    // An environment.yaml written before this block existed leaves it undefined.
    // The scalar must then be the whole rule, exactly as it was before.
    it('falls back to the scalar for every origin when the block is absent', async () => {
      versionsConfig.minIntervalSecondsByOrigin = undefined

      await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'collabora' })
      queries.rows[0].createdAt = new Date(Date.now() - 61_000)
      await fs.writeFile(filePath, 'just over the scalar window')
      await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'collabora' })

      expect(queries.rows).toHaveLength(2)
    })
  })

  /* -------------------------------------------------------------- quota share */

  it('evicts oldest-unlabeled-first to stay under quota * quotaShare', async () => {
    versionsConfig.minIntervalSeconds = 0
    // quota 100, share 0.5 -> ceiling 50. Seed 45 bytes across three versions.
    const space = personalSpace({ storageQuota: 100 })
    for (const [i, size] of [15, 15, 15].entries()) {
      await queries.insertVersion({
        fileId: FILE_ID,
        versionsRoot: 'user:alice',
        checksum: `${i}`.repeat(64).slice(0, 64),
        size,
        mtime: 1,
        origin: 'web'
      } as VersionInsert)
      queries.rows[i].createdAt = new Date(Date.now() - (10 - i) * 1000)
    }

    await service.snapshotBeforeOverwrite(user, space, { origin: 'web' })

    const { used } = await queries.usageByRoot('user:alice')
    expect(used).toBeLessThanOrEqual(50)
    // The oldest seeded version went first; the newest seeded ones survived.
    expect(queries.rows.map((r) => r.id)).not.toContain(1)
    expect(queries.rows.some((r) => r.origin === 'web' && r.size === CONTENT.length)).toBe(true)
  })

  it('never evicts a labeled version, accepting the overshoot instead', async () => {
    versionsConfig.minIntervalSeconds = 0
    const space = personalSpace({ storageQuota: 100 })
    await queries.insertVersion({
      fileId: FILE_ID,
      versionsRoot: 'user:alice',
      checksum: 'a'.repeat(64),
      size: 60,
      mtime: 1,
      origin: 'web'
    } as VersionInsert)
    queries.rows[0].label = 'keep me forever'

    await service.snapshotBeforeOverwrite(user, space, { origin: 'web' })

    expect(queries.rows.find((r) => r.label === 'keep me forever')).toBeDefined()
    // Overshoot is accepted rather than destroying a named revision.
    expect((await queries.usageByRoot('user:alice')).used).toBeGreaterThan(50)
  })

  // Regression: the eviction loop's condition is `used + incoming > ceiling`.
  // With an incoming version larger than the ceiling that can never be
  // satisfied, so the loop used to evict until nothing unlabeled was left —
  // destroying every other file's history in the root — and then insert
  // anyway, still over the ceiling. Maximum destruction, zero benefit.
  it('refuses to version a single write larger than the ceiling instead of evicting everything', async () => {
    versionsConfig.minIntervalSeconds = 0
    const space = personalSpace({ storageQuota: 100 }) // ceiling 50
    for (const [i, fileId] of [1000, 1001, 1002].entries()) {
      await queries.insertVersion({
        fileId,
        versionsRoot: 'user:alice',
        checksum: `${i}`.repeat(64).slice(0, 64),
        size: 10,
        mtime: 1,
        origin: 'web'
      } as VersionInsert)
    }
    await fs.writeFile(filePath, 'x'.repeat(80)) // 80 > ceiling 50

    await service.snapshotBeforeOverwrite(user, space, { origin: 'web' })

    // Every pre-existing version survives, and no oversized row was inserted.
    expect(queries.rows).toHaveLength(3)
    expect(queries.rows.map((r) => r.fileId).sort()).toEqual([1000, 1001, 1002])
    // Nor is a blob left behind for the write we declined to version.
    expect(await blobFiles()).toHaveLength(0)
  })

  // Regression: the ceiling came from space.storageQuota (the CURRENT env)
  // while eviction targets the recorded root. For a share with an external
  // path the root is the acting user's own, so a write into someone else's
  // small share would evict the user's personal history.
  it('skips the cap when the env quota belongs to a different scope than the versions root', async () => {
    versionsConfig.minIntervalSeconds = 0
    await queries.insertVersion({
      fileId: 999,
      versionsRoot: 'user:alice',
      checksum: 'c'.repeat(64),
      size: 90,
      mtime: 1,
      origin: 'web'
    } as VersionInsert)

    // A share with an external path: root resolves to user:alice, but the env
    // carries the share's small quota.
    const shareSpace = personalSpace({
      inPersonalSpace: false,
      inFilesRepository: false,
      inSharesRepository: true,
      alias: 'some-share',
      storageQuota: 100,
      root: { externalPath: '/mnt/external' }
    })

    await service.snapshotBeforeOverwrite(user, shareSpace, { origin: 'web' })

    // The pre-existing personal version is untouched: 90 + new > 50 would have
    // evicted it under the old, mismatched calculation.
    expect(queries.rows.find((r) => r.fileId === 999)).toBeDefined()
  })

  // C2 regression, at the seam where the bug lived. Labeled versions are never
  // evictable, so if labeled bytes ALONE exceed the ceiling no sequence of
  // evictions can reach it — and a `while (used > ceiling)` loop then deletes
  // every unlabeled version in the root, including every other file's, and still
  // finishes over the ceiling. Maximum destruction, zero benefit.
  it('evicts nothing when labeled versions alone exceed the ceiling', async () => {
    for (const [i, fileId] of [10, 11, 12].entries()) {
      await queries.insertVersion({
        fileId,
        versionsRoot: 'user:alice',
        checksum: `${i}`.repeat(64).slice(0, 64),
        size: 10,
        mtime: 1,
        origin: 'web'
      } as VersionInsert)
    }
    await queries.insertVersion({
      fileId: 13,
      versionsRoot: 'user:alice',
      checksum: 'f'.repeat(64),
      size: 1200,
      mtime: 1,
      origin: 'web'
    } as VersionInsert)
    queries.rows[3].label = 'a huge named revision'

    // Ceiling 500; labeled alone is 1200, so nothing can help.
    const removed = await service.evictUntilUnderCeiling('user:alice', 500)

    expect(removed).toBe(0)
    // Every other file's unlabeled history survives.
    expect(queries.rows).toHaveLength(4)
  })

  it('evicts oldest-unlabeled-first until under the ceiling when that is achievable', async () => {
    for (const [i, size] of [100, 100, 100].entries()) {
      await queries.insertVersion({
        fileId: 20 + i,
        versionsRoot: 'user:alice',
        checksum: `${i}`.repeat(64).slice(0, 64),
        size,
        mtime: 1,
        origin: 'web'
      } as VersionInsert)
      queries.rows[i].createdAt = new Date(Date.now() - (10 - i) * 1000)
    }

    const removed = await service.evictUntilUnderCeiling('user:alice', 150)

    expect(removed).toBe(2)
    // The two oldest went; the newest survived.
    expect(queries.rows.map((r) => r.fileId)).toEqual([22])
  })

  it('terminates when a victim reports zero size, rather than looping forever', async () => {
    // A zero-size row does not reduce `used`, so a loop that only exits on
    // "used <= ceiling" must still make progress by consuming rows.
    for (const [i, size] of [0, 100].entries()) {
      await queries.insertVersion({
        fileId: 30 + i,
        versionsRoot: 'user:alice',
        checksum: `${i}`.repeat(64).slice(0, 64),
        size,
        mtime: 1,
        origin: 'web'
      } as VersionInsert)
      queries.rows[i].createdAt = new Date(Date.now() - (10 - i) * 1000)
    }

    const removed = await service.evictUntilUnderCeiling('user:alice', 50)

    expect(removed).toBe(2)
    expect(queries.rows).toHaveLength(0)
  })

  it('skips the cap entirely for a space with no quota', async () => {
    versionsConfig.minIntervalSeconds = 0
    await queries.insertVersion({
      fileId: FILE_ID,
      versionsRoot: 'user:alice',
      checksum: 'a'.repeat(64),
      size: 10_000_000,
      mtime: 1,
      origin: 'web'
    } as VersionInsert)

    await service.snapshotBeforeOverwrite(user, personalSpace({ storageQuota: 0 }), { origin: 'web' })

    expect(queries.rows).toHaveLength(2)
  })

  it('skips the cap when quotaShare is disabled', async () => {
    versionsConfig.minIntervalSeconds = 0
    versionsConfig.quotaShare = false
    await queries.insertVersion({
      fileId: FILE_ID,
      versionsRoot: 'user:alice',
      checksum: 'a'.repeat(64),
      size: 10_000,
      mtime: 1,
      origin: 'web'
    } as VersionInsert)

    await service.snapshotBeforeOverwrite(user, personalSpace({ storageQuota: 100 }), { origin: 'web' })

    expect(queries.rows).toHaveLength(2)
  })

  /* ------------------------------------------------------- never throws to caller */

  it('swallows a snapshot failure so the caller’s save still succeeds', async () => {
    ensurer.ensureFileId.mockRejectedValue(new Error('db down'))
    await expect(service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })).resolves.toBeUndefined()
    expect(queries.rows).toHaveLength(0)
  })

  it('swallows a blob-write failure too', async () => {
    vi.spyOn(fs, 'copyFile').mockRejectedValue(Object.assign(new Error('nope'), { code: 'EIO' }))
    await expect(service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })).resolves.toBeUndefined()
    // No row without a blob: the blob is written first precisely so a crash
    // leaves a sweepable orphan rather than an un-downloadable entry.
    expect(queries.rows).toHaveLength(0)
  })

  /* ------------------------------------------------------------------ disabled */

  it('no-ops every entry point while the feature flag is off', async () => {
    versionsConfig.enabled = false
    const space = personalSpace()

    await service.snapshotBeforeOverwrite(user, space, { origin: 'web' })
    expect(queries.rows).toHaveLength(0)
    expect(await blobFiles()).toHaveLength(0)

    expect(await service.listVersions(user, space)).toEqual([])
    expect(await service.versionsUsage(user, space)).toEqual({ used: 0, ceiling: null, count: 0 })
    await service.purgeForFile(FILE_ID)
    await service.purgeForPath(space.dbFile, false)
    await expect(service.restoreVersion(user, space, 1)).rejects.toThrow(FileError)
    expect(service.enabled).toBe(false)
  })

  /* --------------------------------------------------------------------- reads */

  it('lists history newest-first with the author attached', async () => {
    versionsConfig.minIntervalSeconds = 0
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    await fs.writeFile(filePath, 'v2')
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'webdav' })

    const list = await service.listVersions(user, personalSpace())
    expect(list.map((v) => v.origin)).toEqual(['webdav', 'web'])
    expect(list[0].author).toEqual({ login: 'alice', fullName: 'Alice A' })
  })

  it('listing does not materialize a files row', async () => {
    await service.listVersions(user, personalSpace())
    // Reads must never create rows, or every poll of a file with no history
    // would leave one behind.
    expect(ensurer.ensureFileId).not.toHaveBeenCalled()
    expect(filesQueries.getUserFileByPath).toHaveBeenCalled()
  })

  it('reports usage with the quotaShare ceiling', async () => {
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    const usage = await service.versionsUsage(user, personalSpace({ storageQuota: 1000 }))
    expect(usage).toMatchObject({ count: 1, used: CONTENT.length, ceiling: 500 })
  })

  // Regression (#338): the reported ceiling and the enforced ceiling were two
  // independent derivations of one number. rootQuota deliberately skips the
  // eager cap when the env's quota belongs to a different scope than the
  // versions root — a share with an external path — but versionsUsage still
  // reported storageQuota * quotaShare, advertising a limit nothing would ever
  // apply. Both now come from rootQuota, so this pins them together.
  it('reports no ceiling when the env quota belongs to a different scope than the versions root', async () => {
    versionsConfig.minIntervalSeconds = 0
    const shareSpace = personalSpace({
      inPersonalSpace: false,
      inFilesRepository: false,
      inSharesRepository: true,
      alias: 'some-share',
      storageQuota: 1000,
      root: { externalPath: '/mnt/external' }
    })

    await service.snapshotBeforeOverwrite(user, shareSpace, { origin: 'web' })
    const usage = await service.versionsUsage(user, shareSpace)

    // Bytes are still reported — they are real and they still count towards the
    // quota — but no eager cap applies here, so there is no ceiling to show.
    expect(usage).toMatchObject({ count: 1, used: CONTENT.length, ceiling: null })
  })

  it('streams a version’s stored bytes', async () => {
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    const { stream, version } = await service.getVersionStream(user, personalSpace(), queries.rows[0].id)
    const chunks: Buffer[] = []
    for await (const c of stream) chunks.push(c as Buffer)
    expect(Buffer.concat(chunks).toString()).toBe(CONTENT)
    expect(version.origin).toBe('web')
  })

  // A stored versionsRoot is a database value, so it is still untrusted at the
  // point it becomes a filesystem path. It used to reach
  // UserModel.getHomePath's "login must be a single path segment" throw, which
  // escaped as a raw 500 on the download and restore endpoints; the path helper
  // now returns null and callers turn that into an honest 404.
  it.each([
    ['a traversal attempt in the login', 'user:../../etc'],
    ['a separator in the alias', 'space:a/b'],
    ['an unrecognized discriminator', 'nonsense:x']
  ])('404s rather than 500s when a row has %s', async (_label, badRoot) => {
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    queries.rows[0].versionsRoot = badRoot

    await expect(service.getVersionStream(user, personalSpace(), queries.rows[0].id)).rejects.toThrow(FileError)
    await expect(service.restoreVersion(user, personalSpace(), queries.rows[0].id)).rejects.toThrow(FileError)
  })

  it('404s a version id belonging to a different file', async () => {
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    queries.rows[0].fileId = 999999
    // The authorization boundary for every by-id call: the version must hang
    // off the fileId the caller's resolved space env points at.
    await expect(service.getVersionStream(user, personalSpace(), queries.rows[0].id)).rejects.toThrow(FileError)
  })

  /* ------------------------------------------------------------------ restore */

  it('restores content, snapshots the pre-restore state, and PRESERVES THE INODE', async () => {
    versionsConfig.minIntervalSeconds = 0
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    const versionId = queries.rows[0].id

    await fs.writeFile(filePath, 'clobbered content')
    const inodeBefore = (await fs.stat(filePath)).ino

    await service.restoreVersion(user, personalSpace(), versionId)

    expect(await fs.readFile(filePath, 'utf8')).toBe(CONTENT)
    // Both editors avoid moveFiles for exactly this reason: trash retention
    // keys on inodes and dbFileHash/file.id consumers depend on inode
    // stability. A restore that swapped the inode would look like delete+create.
    expect((await fs.stat(filePath)).ino).toBe(inodeBefore)

    const restoreRow = queries.rows.find((r) => r.origin === 'restore')
    expect(restoreRow).toBeDefined()
    expect(filesQueries.updateFile).toHaveBeenCalledWith(FILE_ID, { size: CONTENT.length, mtime: expect.any(Number) })
  })

  // Task D3, the filesystem half. The test above pins the inode; this pins the
  // three fields the desktop sync client actually diffs on.
  //
  // sync-manager's diff tuple is [isDir, size, mtime(s), ino, checksum], and it
  // reuses the client's cached checksum only when size AND mtime AND ino all
  // match (sync-manager.service.ts::checkSumFile). So a restore has to move at
  // least one of size/mtime for the client to notice at all — and it moves both,
  // while ino holds. Together with the sync-side test in
  // sync/services/sync-manager.service.spec.ts ("file versioning interplay
  // (D3)"), that is the whole propagation claim: no sync-side code needed.
  it('changes the size, mtime and content hash the sync diff keys on, while the inode holds', async () => {
    versionsConfig.minIntervalSeconds = 0
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    const versionId = queries.rows[0].id

    // A clobbering write of a DIFFERENT length, so size alone would be enough
    // to distinguish it — and then the restore has to move it back.
    await fs.writeFile(filePath, 'a much longer clobbering write than the original content was')
    // fs mtime resolution is coarse enough on some filesystems that two writes
    // in the same millisecond compare equal; hold the clobbered state at a
    // distinctly older mtime so the assertion cannot pass by accident.
    const clobberedAt = new Date(Date.now() - 60_000)
    await fs.utimes(filePath, clobberedAt, clobberedAt)
    const before = await fs.stat(filePath)
    const hashOf = async () =>
      crypto
        .createHash('sha512-256')
        .update(await fs.readFile(filePath))
        .digest('hex')
    const hashBefore = await hashOf()

    await service.restoreVersion(user, personalSpace(), versionId)

    const after = await fs.stat(filePath)
    expect(after.ino).toBe(before.ino)
    expect(after.size).not.toBe(before.size)
    expect(after.size).toBe(CONTENT.length)
    expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs)
    expect(await hashOf()).not.toBe(hashBefore)
  })

  it('restore holds a server lock and releases it', async () => {
    versionsConfig.minIntervalSeconds = 0
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    await service.restoreVersion(user, personalSpace(), queries.rows[0].id)
    expect(lockManager.createOrRefresh).toHaveBeenCalledTimes(1)
    expect(lockManager.removeLock).toHaveBeenCalledWith('lock-1')
  })

  it('restore refuses when SOMEONE ELSE holds the lock, and does not touch the file', async () => {
    versionsConfig.minIntervalSeconds = 0
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    await fs.writeFile(filePath, 'someone else is editing')
    lockManager.createOrRefresh.mockRejectedValue(new LockConflict({ key: 'other' } as any, 'Conflicting lock'))

    await expect(service.restoreVersion(user, personalSpace(), queries.rows[0].id)).rejects.toThrow(LockConflict)
    expect(await fs.readFile(filePath, 'utf8')).toBe('someone else is editing')
  })

  // The bug this replaced: restore used `create`, which treats ANY existing lock
  // as a conflict — including the caller's own. The v2 editor takes a lock on
  // every file it opens, and that is the same screen that offers Restore, so
  // restoring a file you had open failed 100% of the time with an opaque 500.
  it('restores a file the CALLER already has locked, and leaves that lock in place', async () => {
    versionsConfig.minIntervalSeconds = 0
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    await fs.writeFile(filePath, 'edited in the editor')
    // What createOrRefresh returns when the lock is already yours: not created,
    // no conflict.
    lockManager.createOrRefresh.mockResolvedValue([false, { key: 'editor-lock' }])

    await service.restoreVersion(user, personalSpace(), queries.rows[0].id)

    // The snapshotted content is back, so the restore ran rather than being
    // refused by the caller's own lock.
    expect(await fs.readFile(filePath, 'utf8')).toBe('the content that is about to be destroyed')
    // Releasing it would silently unlock a file still open in the editor.
    expect(lockManager.removeLock).not.toHaveBeenCalled()
  })

  // Regression, and the worst bug found in review: restore used to resolve the
  // blob path, check it existed, and only THEN take its safety snapshot. That
  // snapshot's quota eviction picks the oldest unlabeled version — very often
  // exactly the old revision being restored — unlinked the blob, and the write
  // then truncated the live file to zero bytes before failing to read its
  // source. Asking to go back destroyed both the file and the thing you asked
  // to go back to.
  it('restores at the quota ceiling without destroying the version it is restoring', async () => {
    versionsConfig.minIntervalSeconds = 0
    // ceiling 50; the only version present is the oldest unlabeled one, so it
    // is precisely what eviction would pick.
    const space = personalSpace({ storageQuota: 100 })
    await service.snapshotBeforeOverwrite(user, space, { origin: 'web' })
    const versionId = queries.rows[0].id
    expect(queries.rows).toHaveLength(1)

    await fs.writeFile(filePath, 'x'.repeat(45))

    await service.restoreVersion(user, space, versionId)

    expect(await fs.readFile(filePath, 'utf8')).toBe(CONTENT)
    expect(queries.rows.some((r) => r.id === versionId)).toBe(true)
    expect((await fs.stat(filePath)).size).toBeGreaterThan(0)
  })

  it('refuses to restore a blob whose size disagrees with its row, leaving the live file intact', async () => {
    versionsConfig.minIntervalSeconds = 0
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    const versionId = queries.rows[0].id
    await fs.writeFile(filePath, 'current live content')
    // Corrupt the blob: shorter than the recorded size.
    const [blob] = await blobFiles()
    await fs.writeFile(blob, 'truncated')

    await expect(service.restoreVersion(user, personalSpace(), versionId)).rejects.toThrow(FileError)
    // The check happens before the write, so the live file is untouched.
    expect(await fs.readFile(filePath, 'utf8')).toBe('current live content')
  })

  it('restore releases the lock even when the copy fails', async () => {
    versionsConfig.minIntervalSeconds = 0
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    const versionId = queries.rows[0].id
    // Destroy the blob so copyFileContent fails mid-restore.
    for (const b of await blobFiles()) await fs.rm(b)

    await expect(service.restoreVersion(user, personalSpace(), versionId)).rejects.toThrow(FileError)
    expect(lockManager.removeLock).not.toHaveBeenCalled() // rejected before the lock was taken
  })

  /* -------------------------------------------------------------- permissions */

  it('denies restore, label and delete to a member without MODIFY', async () => {
    versionsConfig.minIntervalSeconds = 0
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    const id = queries.rows[0].id
    const readOnly = personalSpace({ envPermissions: '' })

    await expect(service.restoreVersion(user, readOnly, id)).rejects.toThrow(FileError)
    await expect(service.setLabel(user, readOnly, id, 'x')).rejects.toThrow(FileError)
    await expect(service.deleteVersion(user, readOnly, id)).rejects.toThrow(FileError)
    // Reads stay allowed for a read-only member.
    await expect(service.listVersions(user, readOnly)).resolves.toHaveLength(1)
    await expect(service.getVersionStream(user, readOnly, id)).resolves.toBeDefined()
  })

  // The trash is read-only — space.guard.ts enforces that for every ADD/MODIFY
  // request, and using canModifySpaceEnv here states the rule once rather than
  // restating half of it. Nothing is lost: permanently deleting the file from
  // the trash purges its versions anyway.
  it('refuses restore, label and delete in the trash even with MODIFY permission', async () => {
    versionsConfig.minIntervalSeconds = 0
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    const id = queries.rows[0].id
    const inTrash = personalSpace({ inTrashRepository: true, envPermissions: 'a:m:d' })

    await expect(service.restoreVersion(user, inTrash, id)).rejects.toThrow(FileError)
    await expect(service.setLabel(user, inTrash, id, 'x')).rejects.toThrow(FileError)
    await expect(service.deleteVersion(user, inTrash, id)).rejects.toThrow(FileError)
    expect(queries.rows).toHaveLength(1)

    // Reading history of a trashed file is still fine.
    await expect(service.listVersions(user, inTrash)).resolves.toHaveLength(1)
  })

  /* ------------------------------------------------------------ label / delete */

  it('sets and clears a label, normalizing blank input to null', async () => {
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    const id = queries.rows[0].id

    await service.setLabel(user, personalSpace(), id, '  before migration  ')
    expect(queries.rows[0].label).toBe('before migration')

    await service.setLabel(user, personalSpace(), id, '   ')
    expect(queries.rows[0].label).toBeNull()
  })

  it('requires explicit confirmation to delete a labeled version', async () => {
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    const id = queries.rows[0].id
    await service.setLabel(user, personalSpace(), id, 'milestone')

    await expect(service.deleteVersion(user, personalSpace(), id)).rejects.toThrow(FileError)
    expect(queries.rows).toHaveLength(1)

    await service.deleteVersion(user, personalSpace(), id, true)
    expect(queries.rows).toHaveLength(0)
    expect(await blobFiles()).toHaveLength(0)
  })

  it('deleting a version removes its blob only when nothing else references it', async () => {
    versionsConfig.minIntervalSeconds = 0
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    expect(await blobFiles()).toHaveLength(1)

    await service.deleteVersion(user, personalSpace(), queries.rows[0].id)
    // Still referenced by the second identical version.
    expect(await blobFiles()).toHaveLength(1)

    await service.deleteVersion(user, personalSpace(), queries.rows[0].id)
    expect(await blobFiles()).toHaveLength(0)
  })

  /* -------------------------------------------------------------------- purge */

  it('purges a file’s versions and their blobs', async () => {
    versionsConfig.minIntervalSeconds = 0
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    await fs.writeFile(filePath, 'v2')
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    expect(await blobFiles()).toHaveLength(2)

    await service.purgeForFile(FILE_ID)

    expect(queries.rows).toHaveLength(0)
    expect(await blobFiles()).toHaveLength(0)
  })

  it('purges every descendant of a deleted directory, not just the directory itself', async () => {
    versionsConfig.minIntervalSeconds = 0
    // deleteFiles removes all descendant rows in one regexp query, so purging
    // by the target id alone would orphan every child's history.
    for (const [i, fileId] of [10, 11, 12].entries()) {
      await queries.insertVersion({
        fileId,
        versionsRoot: 'user:alice',
        checksum: `${i}`.repeat(64).slice(0, 64),
        size: 5,
        mtime: 1,
        origin: 'web'
      } as VersionInsert)
    }
    queries.resolveIds = [10, 11, 12]

    await service.purgeForPath({ ownerId: user.id, path: 'docs', inTrash: true } as any, true)

    expect(queries.rows).toHaveLength(0)
  })

  it('a failed purge does not throw into the caller’s delete', async () => {
    vi.spyOn(queries, 'resolveFileIdsForDelete').mockRejectedValue(new Error('db down'))
    await expect(service.purgeForPath({ ownerId: user.id, path: 'docs', inTrash: true } as any, true)).resolves.toBeUndefined()
  })

  it('keeps a shared blob when only one of two files referencing it is purged', async () => {
    versionsConfig.minIntervalSeconds = 0
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    // A second file with byte-identical content in the same root.
    ensurer.ensureFileId.mockResolvedValue(555)
    await service.snapshotBeforeOverwrite(user, personalSpace(), { origin: 'web' })
    expect(await blobFiles()).toHaveLength(1)

    await service.purgeForFile(FILE_ID)
    expect(await blobFiles()).toHaveLength(1)

    await service.purgeForFile(555)
    expect(await blobFiles()).toHaveLength(0)
  })
})
