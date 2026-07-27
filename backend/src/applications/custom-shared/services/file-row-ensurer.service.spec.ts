import { Test } from '@nestjs/testing'
import { Mock } from 'vitest'
import { FileProps } from '../../files/interfaces/file-props.interface'
import { FilesQueries } from '../../files/services/files-queries.service'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { dbFileFromSpace } from '../../spaces/utils/paths'
import { UserModel } from '../../users/models/user.model'
import { DB_TOKEN_PROVIDER } from '../../../infrastructure/database/constants'
import { FileRowEnsurer } from './file-row-ensurer.service'

vi.mock('../../spaces/utils/paths', () => ({
  dbFileFromSpace: vi.fn()
}))

const mockedDbFileFromSpace = dbFileFromSpace as Mock

// Helper: builds a chainable drizzle SELECT thenable that resolves to `rows`.
// We only need .from().where().limit() to fall through to the row array.
function fakeSelect(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows)
  }
  return chain
}

function fileProps(opts: Partial<FileProps> = {}): FileProps {
  return {
    id: 0,
    name: 'cat.jpg',
    path: 'Photos',
    isDir: false,
    size: 1234,
    ctime: 1_700_000_000_000,
    mtime: 1_700_000_000_000,
    mime: 'image/jpeg',
    ...opts
  } as FileProps
}

describe('FileRowEnsurer', () => {
  let service: FileRowEnsurer
  let db: { select: Mock }
  let filesQueries: { getOrCreateUserFile: Mock; getSpaceFileId: Mock; getOrCreateSpaceFile: Mock }

  const user = { id: 7, login: 'alice' } as unknown as UserModel

  beforeEach(async () => {
    db = { select: vi.fn() }
    filesQueries = {
      getOrCreateUserFile: vi.fn(),
      getSpaceFileId: vi.fn(),
      getOrCreateSpaceFile: vi.fn()
    }
    mockedDbFileFromSpace.mockReturnValue({ spaceId: 42, path: 'Photos' })
    const moduleRef = await Test.createTestingModule({
      providers: [FileRowEnsurer, { provide: DB_TOKEN_PROVIDER, useValue: db }, { provide: FilesQueries, useValue: filesQueries }]
    }).compile()
    moduleRef.useLogger(['fatal'])
    service = moduleRef.get(FileRowEnsurer)
  })

  function personalSpace(): SpaceEnv {
    return { inPersonalSpace: true, inTrashRepository: false } as unknown as SpaceEnv
  }
  function sharedSpace(): SpaceEnv {
    return { inPersonalSpace: false, inTrashRepository: false } as unknown as SpaceEnv
  }

  // Personal space — both branches.

  it('personal: returns the existing DB id from the path-keyed lookup (no insert)', async () => {
    db.select.mockReturnValue(fakeSelect([{ id: 555 }]))
    const id = await service.ensureFileId(user, personalSpace(), fileProps())
    expect(id).toBe(555)
    expect(db.select).toHaveBeenCalledTimes(1)
    expect(filesQueries.getOrCreateUserFile).not.toHaveBeenCalled()
  })

  it('personal: inserts on a genuine miss and returns the new id', async () => {
    db.select.mockReturnValue(fakeSelect([]))
    filesQueries.getOrCreateUserFile.mockResolvedValue(999)
    const id = await service.ensureFileId(user, personalSpace(), fileProps({ id: -987654 }))
    expect(id).toBe(999)
    expect(filesQueries.getOrCreateUserFile).toHaveBeenCalledTimes(1)
    // Crucial: id is forced to 0 for the insert path so getOrCreateUserFile
    // doesn't take its "lookup-by-id" branch with a placeholder inode value.
    const [, props] = filesQueries.getOrCreateUserFile.mock.calls[0]
    expect(props.id).toBe(0)
  })

  // Trashing a file keeps its row with the original path and name, only
  // flipping inTrash. Without an inTrash predicate, a NEW file created where a
  // trashed one used to be would resolve to the trashed row — inheriting its
  // version history, and losing that history to the cascade when the trash is
  // emptied. The space branch gets this from convertToWhere; here it is explicit.
  it('personal: scopes the lookup by trash state so a new file does not adopt a trashed row', async () => {
    db.select.mockReturnValue(fakeSelect([]))
    filesQueries.getOrCreateUserFile.mockResolvedValue(1234)

    const id = await service.ensureFileId(user, personalSpace(), fileProps())

    expect(id).toBe(1234)
    // A live env must not match trashed rows, so a row is created instead.
    expect(filesQueries.getOrCreateUserFile).toHaveBeenCalledTimes(1)
  })

  it('personal: a trash-repository env looks up trashed rows', async () => {
    db.select.mockReturnValue(fakeSelect([{ id: 777 }]))
    const trashEnv = { inPersonalSpace: true, inTrashRepository: true } as unknown as SpaceEnv

    await expect(service.ensureFileId(user, trashEnv, fileProps())).resolves.toBe(777)
  })

  it('personal: matches on isDir so a dir and a file at the same (path, name) do not alias', async () => {
    db.select.mockReturnValue(fakeSelect([]))
    filesQueries.getOrCreateUserFile.mockResolvedValue(321)
    const id = await service.ensureFileId(user, personalSpace(), fileProps({ isDir: true, name: 'Subfolder' }))
    expect(id).toBe(321)
    const [, props] = filesQueries.getOrCreateUserFile.mock.calls[0]
    expect(props).toMatchObject({ id: 0, isDir: true, path: 'Photos', name: 'Subfolder' })
  })

  // The documented failure mode this service exists to prevent: `files` has no
  // unique index on (ownerId, path, name), so a blind getOrCreateUserFile call
  // fans out duplicate rows on every repeat. The second call must find the row
  // the first one created and return the same id without inserting again.

  it('personal: a second call for the same path reuses the row — no duplicate insert', async () => {
    let inserted: number | undefined
    db.select.mockImplementation(() => fakeSelect(inserted ? [{ id: inserted }] : []))
    filesQueries.getOrCreateUserFile.mockImplementation(async () => {
      inserted = 4242
      return inserted
    })
    const props = fileProps({ id: -987654 })

    const first = await service.ensureFileId(user, personalSpace(), props)
    const second = await service.ensureFileId(user, personalSpace(), props)

    expect(first).toBe(4242)
    expect(second).toBe(4242)
    expect(filesQueries.getOrCreateUserFile).toHaveBeenCalledTimes(1)
  })

  // Shared / external space — both branches.

  it('shared: returns the existing DB id from getSpaceFileId (no insert)', async () => {
    filesQueries.getSpaceFileId.mockResolvedValue(777)
    const id = await service.ensureFileId(user, sharedSpace(), fileProps())
    expect(id).toBe(777)
    expect(filesQueries.getOrCreateSpaceFile).not.toHaveBeenCalled()
  })

  it('shared: inserts on a genuine miss and returns the new id', async () => {
    filesQueries.getSpaceFileId.mockResolvedValue(0)
    filesQueries.getOrCreateSpaceFile.mockResolvedValue(888)
    const id = await service.ensureFileId(user, sharedSpace(), fileProps())
    expect(id).toBe(888)
    expect(filesQueries.getOrCreateSpaceFile).toHaveBeenCalledTimes(1)
    // Scope comes from dbFileFromSpace, never from the caller's props.
    const [fileId, , dbFile] = filesQueries.getOrCreateSpaceFile.mock.calls[0]
    expect(fileId).toBe(0)
    expect(dbFile).toMatchObject({ spaceId: 42 })
  })

  it('shared: a second call for the same path reuses the row — no duplicate insert', async () => {
    let inserted = 0
    filesQueries.getSpaceFileId.mockImplementation(async () => inserted)
    filesQueries.getOrCreateSpaceFile.mockImplementation(async () => {
      inserted = 1212
      return inserted
    })
    const props = fileProps()

    const first = await service.ensureFileId(user, sharedSpace(), props)
    const second = await service.ensureFileId(user, sharedSpace(), props)

    expect(first).toBe(1212)
    expect(second).toBe(1212)
    expect(filesQueries.getOrCreateSpaceFile).toHaveBeenCalledTimes(1)
  })

  it('shared: external-root and share scopes are passed through from dbFileFromSpace untouched', async () => {
    mockedDbFileFromSpace.mockReturnValue({ spaceId: 42, spaceExternalRootId: 9, shareExternalId: null, path: 'Photos' })
    filesQueries.getSpaceFileId.mockResolvedValue(0)
    filesQueries.getOrCreateSpaceFile.mockResolvedValue(31)
    const id = await service.ensureFileId(user, sharedSpace(), fileProps())
    expect(id).toBe(31)
    const [, , dbFile] = filesQueries.getOrCreateSpaceFile.mock.calls[0]
    expect(dbFile).toMatchObject({ spaceId: 42, spaceExternalRootId: 9, shareExternalId: null })
  })

  // Failure modes — callers must be able to degrade, never see a throw.

  it('returns 0 when the personal lookup throws', async () => {
    db.select.mockImplementation(() => {
      throw new Error('connection lost')
    })
    await expect(service.ensureFileId(user, personalSpace(), fileProps())).resolves.toBe(0)
  })

  it('returns 0 when the shared upsert throws', async () => {
    filesQueries.getSpaceFileId.mockRejectedValue(new Error('deadlock'))
    await expect(service.ensureFileId(user, sharedSpace(), fileProps())).resolves.toBe(0)
  })

  it('returns 0 when the insert helper resolves to a falsy id', async () => {
    db.select.mockReturnValue(fakeSelect([]))
    filesQueries.getOrCreateUserFile.mockResolvedValue(undefined)
    await expect(service.ensureFileId(user, personalSpace(), fileProps())).resolves.toBe(0)
  })
})
