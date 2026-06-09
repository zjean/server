import { HttpException, HttpStatus } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SPACE_ALIAS, SPACE_REPOSITORY } from '../../spaces/constants/spaces'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { UserModel } from '../../users/models/user.model'
import { SYNC_TOKEN_URN_PREFIX } from '../utils/nc-sync-xml'
import { NcFileRowEnsurer } from './nc-file-row-ensurer.service'
import { NcSyncLogService } from './nc-sync-log.service'
import { NcSyncReportService } from './nc-sync-report.service'
import { Mock } from 'vitest'

// Build a SpaceEnv-shaped object good enough for the prop builder, without
// going through the real .setup() (which needs a UserModel + filesystem).
function fakePersonalSpace(realBasePath: string, login: string, userId = 7): SpaceEnv {
  const space = Object.create(SpaceEnv.prototype) as SpaceEnv
  Object.assign(space, {
    id: 1,
    alias: SPACE_ALIAS.PERSONAL,
    name: 'personal',
    enabled: true,
    permissions: 'arwdmsu',
    envPermissions: 'arwdmsu',
    repository: SPACE_REPOSITORY.FILES,
    inFilesRepository: true,
    inTrashRepository: false,
    inSharesRepository: false,
    inPersonalSpace: true,
    inSharesList: false,
    realBasePath,
    realPath: realBasePath,
    relativeUrl: '.',
    url: `personal`,
    paths: [],
    // Mirrors what dbFileFromSpace produces for a personal space; passed to
    // NcFileRowEnsurer.ensure so the fake must populate it.
    dbFile: { ownerId: userId, path: '.', inTrash: false },
    root: { id: 0, alias: '', name: '', permissions: 'arwdmsu', owner: { id: userId, login } }
  })
  return space
}

function fakeUser(login: string, id = 7): UserModel {
  return { id, login } as UserModel
}

// Bare minimum FastifyReply mock — captures status, body, content-type. No
// real Fastify lifecycle. Returns itself so chained calls (.type().status()
// .send()) work.
function fakeReply() {
  const captured: { status?: number; type?: string; body?: string } = {}
  const reply = {
    type(t: string) {
      captured.type = t
      return reply
    },
    status(n: number) {
      captured.status = n
      return reply
    },
    send(b: string) {
      captured.body = b
      return reply
    }
  }
  return { reply: reply as never, captured }
}

describe(NcSyncReportService.name, () => {
  let moduleRef: TestingModule
  let service: NcSyncReportService
  let log: { since: Mock; minKeptToken: Mock; currentToken: Mock }
  let fileRowEnsurer: { ensure: Mock }
  let tmpRoot: string
  let user: UserModel
  let space: SpaceEnv

  beforeEach(async () => {
    log = {
      since: vi.fn().mockResolvedValue([]),
      minKeptToken: vi.fn().mockResolvedValue(0),
      currentToken: vi.fn().mockResolvedValue(0)
    }
    // Default: pass the file's existing id through (inode placeholder or real).
    // Individual tests can override to assert a specific DB id is emitted.
    fileRowEnsurer = { ensure: vi.fn().mockImplementation((f: { id: number }) => Promise.resolve(f.id)) }
    moduleRef = await Test.createTestingModule({
      providers: [NcSyncReportService, { provide: NcSyncLogService, useValue: log }, { provide: NcFileRowEnsurer, useValue: fileRowEnsurer }]
    }).compile()
    moduleRef.useLogger(['fatal'])
    service = moduleRef.get(NcSyncReportService)

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-sync-report-'))
    user = fakeUser('janwiebe')
    space = fakePersonalSpace(tmpRoot, user.login)
  })

  afterEach(async () => {
    await moduleRef.close()
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  function buildReq(body: string | null): { space: SpaceEnv; user: UserModel; body: string | null } {
    return { space, user, body } as never
  }

  it('empty event log → echoes back the client token unchanged', async () => {
    const { reply, captured } = fakeReply()
    const body = `<d:sync-collection xmlns:d="DAV:"><d:sync-token>${SYNC_TOKEN_URN_PREFIX}5</d:sync-token></d:sync-collection>`
    await service.respond(buildReq(body) as never, reply)

    expect(captured.status).toBe(HttpStatus.MULTI_STATUS)
    expect(captured.type).toContain('xml')
    expect(captured.body).toContain(`<d:sync-token>${SYNC_TOKEN_URN_PREFIX}5</d:sync-token>`)
    expect(log.since).toHaveBeenCalledWith({
      ownerId: user.id,
      sinceId: 5,
      spaceAlias: SPACE_ALIAS.PERSONAL,
      limit: 500
    })
  })

  it('first sync (no token) calls since with sinceId=0 and returns the new token', async () => {
    log.since.mockResolvedValueOnce([
      { id: 11, ownerId: 7, repository: 'files', spaceAlias: 'personal', path: 'gone.pdf', type: 'delete', ts: Date.now() }
    ])
    const { reply, captured } = fakeReply()
    await service.respond(buildReq(null) as never, reply)

    expect(captured.body).toContain(`<d:sync-token>${SYNC_TOKEN_URN_PREFIX}11</d:sync-token>`)
    // delete event → href + 404, no propstat
    expect(captured.body).toContain('<d:href>/remote.php/dav/files/janwiebe/gone.pdf</d:href>')
    expect(captured.body).toContain('HTTP/1.1 404 Not Found')
  })

  it('create event with on-disk file → 200 propstat block with file metadata', async () => {
    // create the file under tmpRoot so getProps() succeeds
    const filePath = path.join(tmpRoot, 'photo.jpg')
    await fs.writeFile(filePath, 'pretend-this-is-jpeg')

    log.since.mockResolvedValueOnce([
      { id: 42, ownerId: 7, repository: 'files', spaceAlias: 'personal', path: 'photo.jpg', type: 'create', ts: Date.now() }
    ])
    const { reply, captured } = fakeReply()
    await service.respond(buildReq(null) as never, reply)

    expect(captured.body).toContain('<d:href>/remote.php/dav/files/janwiebe/photo.jpg</d:href>')
    expect(captured.body).toContain('HTTP/1.1 200 OK')
    expect(captured.body).toContain('<d:displayname>photo.jpg</d:displayname>')
    expect(captured.body).toContain(`<d:sync-token>${SYNC_TOKEN_URN_PREFIX}42</d:sync-token>`)
  })

  it('create event for a now-deleted file falls back to 404 (delete) response', async () => {
    log.since.mockResolvedValueOnce([
      { id: 50, ownerId: 7, repository: 'files', spaceAlias: 'personal', path: 'never-existed.txt', type: 'create', ts: Date.now() }
    ])
    const { reply, captured } = fakeReply()
    await service.respond(buildReq(null) as never, reply)

    expect(captured.body).toContain('<d:href>/remote.php/dav/files/janwiebe/never-existed.txt</d:href>')
    expect(captured.body).toContain('HTTP/1.1 404 Not Found')
  })

  it('dedupes (spaceAlias, path) keeping the latest event', async () => {
    // Two events for the same file: first a create, then a later delete.
    // Output should contain only ONE <d:response> for that path — the delete
    // wins (it's later). The new sync-token is the highest event id.
    log.since.mockResolvedValueOnce([
      { id: 10, ownerId: 7, repository: 'files', spaceAlias: 'personal', path: 'foo.txt', type: 'create', ts: 1 },
      { id: 11, ownerId: 7, repository: 'files', spaceAlias: 'personal', path: 'foo.txt', type: 'delete', ts: 2 }
    ])
    const { reply, captured } = fakeReply()
    await service.respond(buildReq(null) as never, reply)

    const matches = captured.body!.match(/<d:href>\/remote\.php\/dav\/files\/janwiebe\/foo\.txt<\/d:href>/g)
    expect(matches?.length).toBe(1)
    expect(captured.body).toContain('HTTP/1.1 404 Not Found')
    expect(captured.body).toContain(`<d:sync-token>${SYNC_TOKEN_URN_PREFIX}11</d:sync-token>`)
  })

  it('returns 412 Precondition Failed when sinceId is older than minKeptToken', async () => {
    log.minKeptToken.mockResolvedValueOnce(100)
    const { reply } = fakeReply()
    const body = `<d:sync-collection xmlns:d="DAV:"><d:sync-token>${SYNC_TOKEN_URN_PREFIX}50</d:sync-token></d:sync-collection>`
    await expect(service.respond(buildReq(body) as never, reply)).rejects.toMatchObject({
      status: HttpStatus.PRECONDITION_FAILED
    })
    expect(log.since).not.toHaveBeenCalled()
  })

  it('throws 400 Bad Request on malformed XML body', async () => {
    const { reply } = fakeReply()
    await expect(service.respond(buildReq('<d:sync-collection><not-closed>') as never, reply)).rejects.toBeInstanceOf(HttpException)
  })

  it('declares all four NC namespaces on the multistatus root', async () => {
    const { reply, captured } = fakeReply()
    await service.respond(buildReq(null) as never, reply)
    expect(captured.body).toContain('xmlns:d="DAV:"')
    expect(captured.body).toContain('xmlns:oc="http://owncloud.org/ns"')
    expect(captured.body).toContain('xmlns:nc="http://nextcloud.org/ns"')
    expect(captured.body).toContain('xmlns:ocs="http://open-collaboration-services.org/ns"')
  })

  it('respects the client-supplied <d:limit><d:nresults>', async () => {
    const { reply } = fakeReply()
    const body = `<d:sync-collection xmlns:d="DAV:"><d:sync-token>${SYNC_TOKEN_URN_PREFIX}0</d:sync-token><d:limit><d:nresults>50</d:nresults></d:limit></d:sync-collection>`
    await service.respond(buildReq(body) as never, reply)
    expect(log.since).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }))
  })

  it('caps client limit at 500', async () => {
    const { reply } = fakeReply()
    const body = `<d:sync-collection xmlns:d="DAV:"><d:sync-token>${SYNC_TOKEN_URN_PREFIX}0</d:sync-token><d:limit><d:nresults>10000</d:nresults></d:limit></d:sync-collection>`
    await service.respond(buildReq(body) as never, reply)
    expect(log.since).toHaveBeenCalledWith(expect.objectContaining({ limit: 500 }))
  })

  // ──────────── oc:filter-files (Favorites tab) ────────────
  // NC iOS sends a REPORT with body <oc:filter-files> + <oc:filter-rules>
  // <oc:favorite>1</oc:favorite> when the user opens the Favorites tab —
  // a different shape from <d:sync-collection>. Sync-in's `files` table
  // doesn't yet carry a favorite column (DB schema follow-up), so we
  // accept the request and return a well-formed empty multistatus rather
  // than 5xx-ing into an iOS spinner.
  describe('respondFilterFiles', () => {
    it('returns a 207 multistatus with no <d:response> entries and all four namespaces', async () => {
      const { reply, captured } = fakeReply()
      const body = `<oc:filter-files xmlns:oc="http://owncloud.org/ns" xmlns:d="DAV:"><d:prop><d:displayname/></d:prop><oc:filter-rules><oc:favorite>1</oc:favorite></oc:filter-rules></oc:filter-files>`
      await service.respondFilterFiles(buildReq(body) as never, reply)

      expect(captured.status).toBe(HttpStatus.MULTI_STATUS)
      expect(captured.type).toContain('xml')
      expect(captured.body).toContain('xmlns:d="DAV:"')
      expect(captured.body).toContain('xmlns:oc="http://owncloud.org/ns"')
      expect(captured.body).toContain('xmlns:nc="http://nextcloud.org/ns"')
      expect(captured.body).toContain('xmlns:ocs="http://open-collaboration-services.org/ns"')
      // Empty result set → the multistatus carries no <d:response> children.
      expect(captured.body).not.toContain('<d:response>')
      // Filter-files responses carry no <d:sync-token> — that's sync-collection-only.
      expect(captured.body).not.toContain('<d:sync-token>')
    })

    it('does not consult the sync log (filter-files is not a delta query)', async () => {
      const { reply } = fakeReply()
      const body = `<oc:filter-files xmlns:oc="http://owncloud.org/ns"><oc:filter-rules><oc:favorite>1</oc:favorite></oc:filter-rules></oc:filter-files>`
      await service.respondFilterFiles(buildReq(body) as never, reply)
      expect(log.since).not.toHaveBeenCalled()
      expect(log.minKeptToken).not.toHaveBeenCalled()
    })
  })

  it('URL-encodes path segments containing special characters', async () => {
    log.since.mockResolvedValueOnce([
      { id: 1, ownerId: 7, repository: 'files', spaceAlias: 'personal', path: 'my docs/résumé.pdf', type: 'delete', ts: 1 }
    ])
    const { reply, captured } = fakeReply()
    await service.respond(buildReq(null) as never, reply)
    // space → %20, é → %C3%A9
    expect(captured.body).toContain('/remote.php/dav/files/janwiebe/my%20docs/r%C3%A9sum%C3%A9.pdf')
  })

  // NcFileRowEnsurer.ensure() is called for create/update events so REPORT
  // emits a stable real DB id (same as PROPFIND does). Without this, iOS
  // caches the inode-placeholder fileid from REPORT and then sees a different
  // id from the next PROPFIND — treating them as two separate files.
  describe('DB id resolution via NcFileRowEnsurer for create/update events', () => {
    it('emits the real DB id returned by the ensurer', async () => {
      const filePath = path.join(tmpRoot, 'photo.jpg')
      await fs.writeFile(filePath, 'pretend-this-is-jpeg')
      fileRowEnsurer.ensure.mockResolvedValueOnce(9999)
      log.since.mockResolvedValueOnce([
        { id: 42, ownerId: 7, repository: 'files', spaceAlias: 'personal', path: 'photo.jpg', type: 'create', ts: Date.now() }
      ])
      const { reply, captured } = fakeReply()
      await service.respond(buildReq(null) as never, reply)

      expect(captured.body).toContain('<oc:fileid>9999</oc:fileid>')
      expect(captured.body).toContain('<oc:id>00000000000000009999syncin</oc:id>')
      expect(fileRowEnsurer.ensure).toHaveBeenCalled()
    })

    it('falls back to the inode placeholder when ensure returns the original id', async () => {
      // Default mock: ensure passes f.id through (inode placeholder path).
      const filePath = path.join(tmpRoot, 'orphan.txt')
      await fs.writeFile(filePath, 'no db row yet')
      log.since.mockResolvedValueOnce([
        { id: 50, ownerId: 7, repository: 'files', spaceAlias: 'personal', path: 'orphan.txt', type: 'create', ts: Date.now() }
      ])
      const { reply, captured } = fakeReply()
      await service.respond(buildReq(null) as never, reply)

      // Still emits *some* positive fileid (abs of inode); must not be 0.
      const match = captured.body!.match(/<oc:fileid>(\d+)<\/oc:fileid>/)
      expect(match).not.toBeNull()
      expect(Number(match![1])).toBeGreaterThan(0)
    })

    it('does not call ensure for delete events (no propstat block to populate)', async () => {
      log.since.mockResolvedValueOnce([
        { id: 11, ownerId: 7, repository: 'files', spaceAlias: 'personal', path: 'gone.pdf', type: 'delete', ts: Date.now() }
      ])
      const { reply } = fakeReply()
      await service.respond(buildReq(null) as never, reply)
      expect(fileRowEnsurer.ensure).not.toHaveBeenCalled()
    })

    it('ensure returning the inode id still renders a valid response — no 0 fileid', async () => {
      // The real ensure() catches DB errors internally and returns f.id (the
      // inode placeholder). Simulate that path: ensure returns a negative id
      // (as getProps stamps onto FS-only files), prop builder maps it to abs().
      const filePath = path.join(tmpRoot, 'photo.jpg')
      await fs.writeFile(filePath, 'pretend-this-is-jpeg')
      fileRowEnsurer.ensure.mockImplementationOnce((f: { id: number }) => Promise.resolve(f.id))
      log.since.mockResolvedValueOnce([
        { id: 42, ownerId: 7, repository: 'files', spaceAlias: 'personal', path: 'photo.jpg', type: 'create', ts: Date.now() }
      ])
      const { reply, captured } = fakeReply()
      await service.respond(buildReq(null) as never, reply)

      expect(captured.body).toContain('HTTP/1.1 200 OK')
      const match = captured.body!.match(/<oc:fileid>(\d+)<\/oc:fileid>/)
      expect(Number(match![1])).toBeGreaterThan(0)
    })
  })

  // RFC 6578 §3.1: sync-collection is anchored at the URL the REPORT was
  // sent to. If iOS/Android REPORT a subfolder (e.g. /files/<user>/Documents/),
  // only events under that subtree should surface. Sync-in's SpaceEnv carries
  // the in-space relative URL on `space.relativeUrl` — '.' at the space root,
  // otherwise the slash-joined subpath.
  describe('subtree filtering by space.relativeUrl', () => {
    it("relativeUrl='.' (space root) returns every event in the space", async () => {
      log.since.mockResolvedValueOnce([
        { id: 10, ownerId: 7, repository: 'files', spaceAlias: 'personal', path: 'top.txt', type: 'delete', ts: 1 },
        { id: 11, ownerId: 7, repository: 'files', spaceAlias: 'personal', path: 'Documents/note.md', type: 'delete', ts: 2 }
      ])
      const { reply, captured } = fakeReply()
      // space.relativeUrl defaults to '.' on the fake personal space.
      await service.respond(buildReq(null) as never, reply)

      expect(captured.body).toContain('<d:href>/remote.php/dav/files/janwiebe/top.txt</d:href>')
      expect(captured.body).toContain('<d:href>/remote.php/dav/files/janwiebe/Documents/note.md</d:href>')
    })

    it("relativeUrl='Documents' returns only events for that folder + its descendants", async () => {
      space.relativeUrl = 'Documents'
      log.since.mockResolvedValueOnce([
        // outside subtree → must be filtered out
        { id: 20, ownerId: 7, repository: 'files', spaceAlias: 'personal', path: 'top.txt', type: 'delete', ts: 1 },
        // exact match (the folder itself) → included (the REPORT URL anchor)
        { id: 21, ownerId: 7, repository: 'files', spaceAlias: 'personal', path: 'Documents', type: 'update', ts: 2 },
        // descendant → included
        { id: 22, ownerId: 7, repository: 'files', spaceAlias: 'personal', path: 'Documents/inside.md', type: 'delete', ts: 3 },
        // sibling whose name starts with the same prefix → must NOT be included
        { id: 23, ownerId: 7, repository: 'files', spaceAlias: 'personal', path: 'DocumentsBackup/old.txt', type: 'delete', ts: 4 }
      ])
      const { reply, captured } = fakeReply()
      await service.respond(buildReq(null) as never, reply)

      expect(captured.body).not.toContain('<d:href>/remote.php/dav/files/janwiebe/top.txt</d:href>')
      expect(captured.body).toContain('<d:href>/remote.php/dav/files/janwiebe/Documents/inside.md</d:href>')
      expect(captured.body).not.toContain('<d:href>/remote.php/dav/files/janwiebe/DocumentsBackup/old.txt</d:href>')
    })

    it('newSyncToken advances past out-of-subtree events so the client does not re-fetch them', async () => {
      space.relativeUrl = 'Documents'
      log.since.mockResolvedValueOnce([
        { id: 30, ownerId: 7, repository: 'files', spaceAlias: 'personal', path: 'Documents/a.txt', type: 'delete', ts: 1 },
        // last raw event is outside the subtree — token must still advance to 31
        { id: 31, ownerId: 7, repository: 'files', spaceAlias: 'personal', path: 'OtherFolder/b.txt', type: 'delete', ts: 2 }
      ])
      const { reply, captured } = fakeReply()
      await service.respond(buildReq(null) as never, reply)

      expect(captured.body).toContain(`<d:sync-token>${SYNC_TOKEN_URN_PREFIX}31</d:sync-token>`)
      expect(captured.body).not.toContain('<d:href>/remote.php/dav/files/janwiebe/OtherFolder/b.txt</d:href>')
    })
  })
})
