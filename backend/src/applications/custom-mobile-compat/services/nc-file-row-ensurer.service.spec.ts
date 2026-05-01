import { Test } from '@nestjs/testing'
import { FilesQueries } from '../../files/services/files-queries.service'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { dbFileFromSpace } from '../../spaces/utils/paths'
import { UserModel } from '../../users/models/user.model'
import { WebDAVFile } from '../../webdav/models/webdav-file.model'
import { DB_TOKEN_PROVIDER } from '../../../infrastructure/database/constants'
import { NcFileRowEnsurer } from './nc-file-row-ensurer.service'

jest.mock('../../spaces/utils/paths', () => ({
  dbFileFromSpace: jest.fn()
}))

const mockedDbFileFromSpace = dbFileFromSpace as jest.Mock

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

interface FsFileOpts {
  id?: number
  name?: string
  isDir?: boolean
  path?: string
}

function fsFile(opts: FsFileOpts = {}): WebDAVFile {
  // The ensurer reads f.id, f.isDir, and (cast to FileProps) path/name. Build
  // a real WebDAVFile so .id is settable on the result. WebDAVFile implements
  // Omit<FileProps, 'path'> at the type level but Object.assigns the full
  // FileProps including path at runtime — the cast is on purpose.
  const props = {
    id: opts.id ?? -987654,
    name: opts.name ?? 'cat.jpg',
    isDir: opts.isDir ?? false,
    size: 1234,
    ctime: Date.now(),
    mtime: Date.now(),
    mime: 'image/jpeg',
    path: opts.path ?? 'Photos'
  }
  return new WebDAVFile(props as unknown as ConstructorParameters<typeof WebDAVFile>[0], '/remote.php/dav/files/alice/')
}

describe('NcFileRowEnsurer', () => {
  let service: NcFileRowEnsurer
  let db: { select: jest.Mock }
  let filesQueries: { getOrCreateUserFile: jest.Mock; getSpaceFileId: jest.Mock; getOrCreateSpaceFile: jest.Mock }

  const user = { id: 7, login: 'alice' } as unknown as UserModel

  beforeEach(async () => {
    db = { select: jest.fn() }
    filesQueries = {
      getOrCreateUserFile: jest.fn(),
      getSpaceFileId: jest.fn(),
      getOrCreateSpaceFile: jest.fn()
    }
    mockedDbFileFromSpace.mockReturnValue({ ownerId: 7, spaceId: 42, path: 'Photos' })
    const moduleRef = await Test.createTestingModule({
      providers: [NcFileRowEnsurer, { provide: DB_TOKEN_PROVIDER, useValue: db }, { provide: FilesQueries, useValue: filesQueries }]
    }).compile()
    moduleRef.useLogger(['fatal'])
    service = moduleRef.get(NcFileRowEnsurer)
  })

  function personalSpace(): SpaceEnv {
    return { inPersonalSpace: true, inTrashRepository: false } as unknown as SpaceEnv
  }
  function sharedSpace(): SpaceEnv {
    return { inPersonalSpace: false, inTrashRepository: false } as unknown as SpaceEnv
  }
  function trashSpace(): SpaceEnv {
    return { inPersonalSpace: true, inTrashRepository: true } as unknown as SpaceEnv
  }

  it('returns f.id unchanged for a positive (already-real) id and never touches DB', async () => {
    const f = fsFile({ id: 100 })
    const result = await service.ensure(f, personalSpace(), user)
    expect(result).toBe(100)
    expect(db.select).not.toHaveBeenCalled()
    expect(filesQueries.getOrCreateUserFile).not.toHaveBeenCalled()
  })

  it('returns f.id unchanged for directories (no fileid-keyed feature for dirs)', async () => {
    const f = fsFile({ id: -123, isDir: true })
    const result = await service.ensure(f, personalSpace(), user)
    expect(result).toBe(-123)
    expect(db.select).not.toHaveBeenCalled()
  })

  it('returns f.id unchanged for trash-repository requests', async () => {
    const f = fsFile({ id: -123 })
    const result = await service.ensure(f, trashSpace(), user)
    expect(result).toBe(-123)
    expect(db.select).not.toHaveBeenCalled()
  })

  it('returns f.id unchanged when no user is attached', async () => {
    const f = fsFile({ id: -123 })
    const result = await service.ensure(f, personalSpace(), undefined)
    expect(result).toBe(-123)
    expect(db.select).not.toHaveBeenCalled()
  })

  // Personal space — both branches.

  it('personal: returns the existing DB id from path-keyed lookup (no insert)', async () => {
    db.select.mockReturnValue(fakeSelect([{ id: 555 }]))
    const f = fsFile({ id: -987654, path: 'Photos', name: 'cat.jpg' })
    const result = await service.ensure(f, personalSpace(), user)
    expect(result).toBe(555)
    expect(db.select).toHaveBeenCalledTimes(1)
    expect(filesQueries.getOrCreateUserFile).not.toHaveBeenCalled()
  })

  it('personal: inserts on a genuine miss and returns the new id', async () => {
    db.select.mockReturnValue(fakeSelect([])) // no existing row
    filesQueries.getOrCreateUserFile.mockResolvedValue(999)
    const f = fsFile({ id: -987654 })
    const result = await service.ensure(f, personalSpace(), user)
    expect(result).toBe(999)
    expect(filesQueries.getOrCreateUserFile).toHaveBeenCalledTimes(1)
    // Crucial: file.id is forced to 0 for the insert path so getOrCreateUserFile
    // doesn't take its "lookup-by-id" branch with the placeholder inode.
    const [, props] = filesQueries.getOrCreateUserFile.mock.calls[0]
    expect(props.id).toBe(0)
  })

  // Shared space — both branches.

  it('shared: returns the existing DB id from getSpaceFileId (no insert)', async () => {
    filesQueries.getSpaceFileId.mockResolvedValue(777)
    const f = fsFile({ id: -987654 })
    const result = await service.ensure(f, sharedSpace(), user)
    expect(result).toBe(777)
    expect(filesQueries.getOrCreateSpaceFile).not.toHaveBeenCalled()
  })

  it('shared: inserts on a genuine miss and returns the new id', async () => {
    filesQueries.getSpaceFileId.mockResolvedValue(0)
    filesQueries.getOrCreateSpaceFile.mockResolvedValue(888)
    const f = fsFile({ id: -987654 })
    const result = await service.ensure(f, sharedSpace(), user)
    expect(result).toBe(888)
    expect(filesQueries.getOrCreateSpaceFile).toHaveBeenCalledTimes(1)
  })

  // Failure mode — graceful degrade.

  it('falls back to f.id when the DB lookup throws (PROPFIND must not fail)', async () => {
    db.select.mockImplementation(() => {
      throw new Error('connection lost')
    })
    const f = fsFile({ id: -987654 })
    const result = await service.ensure(f, personalSpace(), user)
    expect(result).toBe(-987654)
  })
})
