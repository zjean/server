import { NestFastifyApplication } from '@nestjs/platform-fastify'
import { and, eq } from 'drizzle-orm'
import { appBootstrap } from '../../../app.bootstrap'
import { DB_TOKEN_PROVIDER } from '../../../infrastructure/database/constants'
import type { DBSchema } from '../../../infrastructure/database/interfaces/database.interface'
import { dbGetInsertedId } from '../../../infrastructure/database/utils'
import { files } from '../../files/schemas/files.schema'
import { USER_ROLE } from '../../users/constants/user'
import { DeleteUserDto } from '../../users/dto/delete-user.dto'
import { UserModel } from '../../users/models/user.model'
import { AdminUsersManager } from '../../users/services/admin-users-manager.service'
import { generateUserTest } from '../../users/utils/test'
import { VersioningQueries } from '../services/versioning-queries.service'
import { customFilesVersions } from './files-versions.schema'

// Schema-level e2e for custom_files_versions. Unit specs in this repo mock
// DB_TOKEN_PROVIDER, so the guarantees asserted here — round-trip fidelity and
// the ON DELETE CASCADE that lets filesQueries.deleteFiles hard-delete `files`
// rows without erroring — can only be proven against a real MariaDB.
describe('custom_files_versions schema (e2e)', () => {
  let app: NestFastifyApplication
  let db: DBSchema
  let adminUsersManager: AdminUsersManager
  let userTest: UserModel

  const digestA = 'a'.repeat(64)
  const digestB = 'b'.repeat(64)

  beforeAll(async () => {
    app = await appBootstrap()
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    db = app.get<DBSchema>(DB_TOKEN_PROVIDER)
    adminUsersManager = app.get<AdminUsersManager>(AdminUsersManager)
    userTest = await adminUsersManager.createUserOrGuest(new UserModel(generateUserTest(false), false), USER_ROLE.USER)
  })

  afterAll(async () => {
    if (userTest?.id) {
      await adminUsersManager.deleteUserOrGuest(userTest.id, userTest.login, { deleteSpace: true, isGuest: false } satisfies DeleteUserDto)
    }
    await app.close()
  })

  async function insertFileRow(name: string): Promise<number> {
    return dbGetInsertedId(
      await db.insert(files).values({
        ownerId: userTest.id,
        path: 'versioning-e2e',
        name,
        isDir: false,
        inTrash: false,
        mime: 'text-plain',
        size: 10,
        mtime: 1_700_000_000_000,
        ctime: 1_700_000_000_000
      })
    )
  }

  async function insertVersion(fileId: number, overrides: Partial<typeof customFilesVersions.$inferInsert> = {}): Promise<number> {
    return dbGetInsertedId(
      await db.insert(customFilesVersions).values({
        fileId,
        ownerId: userTest.id,
        versionsRoot: `user:${userTest.login}`,
        checksum: digestA,
        size: 10,
        mtime: 1_700_000_000_000,
        origin: 'web',
        ...overrides
      })
    )
  }

  it('round-trips every column, defaulting createdAt and leaving label null', async () => {
    const fileId = await insertFileRow('roundtrip.txt')
    const versionId = await insertVersion(fileId, { size: 4242, mtime: 1_699_000_000_000, origin: 'collabora' })

    const [row] = await db.select().from(customFilesVersions).where(eq(customFilesVersions.id, versionId)).limit(1)

    expect(row).toMatchObject({
      fileId,
      ownerId: userTest.id,
      versionsRoot: `user:${userTest.login}`,
      checksum: digestA,
      size: 4242,
      mtime: 1_699_000_000_000,
      origin: 'collabora',
      label: null,
      spaceId: null,
      spaceExternalRootId: null,
      shareExternalId: null
    })
    // createdAt is DB-defaulted, not supplied by the caller.
    expect(row.createdAt).toBeInstanceOf(Date)

    await db.delete(files).where(eq(files.id, fileId))
  })

  it('stores a label and every origin value the enum declares', async () => {
    const fileId = await insertFileRow('origins.txt')
    const origins = ['web', 'web-patch', 'webdav', 'sync', 'sync-make', 'nc-chunked', 'nc-text', 'collabora', 'onlyoffice', 'restore'] as const

    for (const origin of origins) {
      await insertVersion(fileId, { origin, label: `keep-${origin}` })
    }

    const rows = await db.select().from(customFilesVersions).where(eq(customFilesVersions.fileId, fileId))
    expect(rows).toHaveLength(origins.length)
    expect(rows.map((r) => r.origin).sort()).toEqual([...origins].sort())
    expect(rows.every((r) => r.label?.startsWith('keep-'))).toBe(true)

    await db.delete(files).where(eq(files.id, fileId))
  })

  // The reason the FK exists. filesQueries.deleteFiles hard-deletes `files`
  // rows on permanent delete — including every descendant of a directory in a
  // single regexp query — so a non-cascading FK would make those deletes fail
  // whenever a version row survived. The service still purges explicitly
  // first (the cascade cannot decrement blob refcounts); this is the backstop.
  it('cascades: deleting the parent files row removes its version rows', async () => {
    const fileId = await insertFileRow('cascade.txt')
    await insertVersion(fileId, { checksum: digestA })
    await insertVersion(fileId, { checksum: digestB, size: 11 })

    expect(await db.select().from(customFilesVersions).where(eq(customFilesVersions.fileId, fileId))).toHaveLength(2)

    // Must not throw — that is exactly what a RESTRICT FK would do here.
    await expect(db.delete(files).where(eq(files.id, fileId))).resolves.toBeDefined()

    expect(await db.select().from(customFilesVersions).where(eq(customFilesVersions.fileId, fileId))).toHaveLength(0)
  })

  // Dedup and refcounting are per versions root by design (blobs are
  // physically per root), so the blob index must distinguish the same digest
  // in two different roots.
  it('keeps the same digest in two versions roots as two distinct rows', async () => {
    const fileId = await insertFileRow('dedup.txt')
    await insertVersion(fileId, { checksum: digestA, versionsRoot: `user:${userTest.login}` })
    await insertVersion(fileId, { checksum: digestA, versionsRoot: 'space:some-space' })

    const sameDigest = await db.select().from(customFilesVersions).where(eq(customFilesVersions.checksum, digestA))
    const roots = sameDigest.filter((r) => r.fileId === fileId).map((r) => r.versionsRoot)
    expect(roots).toHaveLength(2)
    expect(new Set(roots).size).toBe(2)

    const inUserRoot = await db
      .select()
      .from(customFilesVersions)
      .where(
        and(
          eq(customFilesVersions.checksum, digestA),
          eq(customFilesVersions.versionsRoot, `user:${userTest.login}`),
          eq(customFilesVersions.fileId, fileId)
        )
      )
    expect(inUserRoot).toHaveLength(1)

    await db.delete(files).where(eq(files.id, fileId))
  })

  // The admin panel's numbers (#342). SUM/GROUP BY/COUNT(DISTINCT) correctness —
  // and MySQL handing SUM() back as a decimal STRING, which is why every
  // aggregate in VersioningQueries wraps its result in Number() — can only be
  // proven against a real MariaDB. A mocked db would agree with any arithmetic.
  it('aggregates totals and per-root usage the way their labels claim', async () => {
    const queries = app.get<VersioningQueries>(VersioningQueries)
    const fileA = await insertFileRow('agg-a.txt')
    const fileB = await insertFileRow('agg-b.txt')
    const root = `user:${userTest.login}`
    const otherRoot = 'space:agg-e2e-space'

    await insertVersion(fileA, { size: 100, versionsRoot: root })
    await insertVersion(fileA, { size: 200, versionsRoot: root, label: 'keep-me' })
    await insertVersion(fileB, { size: 300, versionsRoot: root })
    await insertVersion(fileB, { size: 7, versionsRoot: otherRoot })

    // Per root, exact: two files, three rows, 600 bytes of which 200 are named.
    const perRoot = await queries.usageByAllRoots(100)
    expect(perRoot.find((r) => r.versionsRoot === root)).toEqual({
      versionsRoot: root,
      used: 600,
      labeledBytes: 200,
      count: 3,
      files: 2
    })
    expect(perRoot.find((r) => r.versionsRoot === otherRoot)).toMatchObject({ used: 7, labeledBytes: 0, count: 1, files: 1 })
    // Heaviest first — the ranking is by bytes, which is what quota is charged in.
    const positions = perRoot.map((r) => r.versionsRoot)
    expect(positions.indexOf(root)).toBeLessThan(positions.indexOf(otherRoot))
    // usageByRoot and the grouped query must not disagree about one root.
    expect(await queries.usageByRoot(root)).toEqual({ used: 600, labeledBytes: 200, count: 3 })

    // Totals are asserted against a full read of the table rather than against
    // hard-coded numbers: other cases in this file leave rows behind, and a
    // total that only holds on an empty database is not the total the panel
    // shows.
    const all = await db.select().from(customFilesVersions)
    const totals = await queries.usageTotals()
    expect(totals.used).toBe(all.reduce((n, r) => n + r.size, 0))
    expect(totals.labeledBytes).toBe(all.filter((r) => r.label).reduce((n, r) => n + r.size, 0))
    expect(totals.count).toBe(all.length)
    expect(totals.roots).toBe(new Set(all.map((r) => r.versionsRoot)).size)
    expect(totals.files).toBe(new Set(all.map((r) => r.fileId)).size)

    // The purge's candidate list: unlabeled only, oldest first. The labeled row
    // is absent, which is the whole labeled-version exemption.
    const candidates = await queries.unlabeledByRootOldestFirst(root, 10)
    expect(candidates.map((r) => r.size)).toEqual([100, 300])
    expect((await queries.oldestUnlabeledByRoot(root))?.size).toBe(100)

    await db.delete(files).where(eq(files.id, fileA))
    await db.delete(files).where(eq(files.id, fileB))
  })

  it('accepts a versions root at the full 261-char width (space: + 255-char alias)', async () => {
    const fileId = await insertFileRow('longroot.txt')
    const longRoot = `space:${'x'.repeat(255)}`
    expect(longRoot).toHaveLength(261)

    const versionId = await insertVersion(fileId, { versionsRoot: longRoot })
    const [row] = await db.select().from(customFilesVersions).where(eq(customFilesVersions.id, versionId)).limit(1)
    expect(row.versionsRoot).toBe(longRoot)

    await db.delete(files).where(eq(files.id, fileId))
  })
})
