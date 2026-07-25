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
