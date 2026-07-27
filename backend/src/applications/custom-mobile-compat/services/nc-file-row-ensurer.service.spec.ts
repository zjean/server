import { Test } from '@nestjs/testing'
import { Mock } from 'vitest'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { UserModel } from '../../users/models/user.model'
import { WebDAVFile } from '../../webdav/models/webdav-file.model'
import { FileRowEnsurer } from '../../custom-shared/services/file-row-ensurer.service'
import { NcFileRowEnsurer } from './nc-file-row-ensurer.service'

// The lookup-then-insert core (personal vs space branches, duplicate-row
// avoidance, DB-error handling) is covered by
// custom-shared/services/file-row-ensurer.service.spec.ts. What is asserted
// here is the NC/WebDAV-specific wrapper: short-circuits, DAV url path
// normalization, and the f.id placeholder fallback.

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
  let fileRowEnsurer: { ensureFileId: Mock }

  const user = { id: 7, login: 'alice' } as unknown as UserModel

  beforeEach(async () => {
    fileRowEnsurer = { ensureFileId: vi.fn() }
    const moduleRef = await Test.createTestingModule({
      providers: [NcFileRowEnsurer, { provide: FileRowEnsurer, useValue: fileRowEnsurer }]
    }).compile()
    moduleRef.useLogger(['fatal'])
    service = moduleRef.get(NcFileRowEnsurer)
  })

  function personalSpace(): SpaceEnv {
    return { inPersonalSpace: true, inTrashRepository: false } as unknown as SpaceEnv
  }
  function trashSpace(): SpaceEnv {
    return { inPersonalSpace: true, inTrashRepository: true } as unknown as SpaceEnv
  }

  // Short-circuits — none of these may touch the shared ensurer.

  it('returns f.id unchanged for a positive (already-real) id', async () => {
    const result = await service.ensure(fsFile({ id: 100 }), personalSpace(), user)
    expect(result).toBe(100)
    expect(fileRowEnsurer.ensureFileId).not.toHaveBeenCalled()
  })

  it('returns f.id unchanged for trash-repository requests', async () => {
    const result = await service.ensure(fsFile({ id: -123 }), trashSpace(), user)
    expect(result).toBe(-123)
    expect(fileRowEnsurer.ensureFileId).not.toHaveBeenCalled()
  })

  it('returns f.id unchanged when no user is attached', async () => {
    const result = await service.ensure(fsFile({ id: -123 }), personalSpace(), undefined)
    expect(result).toBe(-123)
    expect(fileRowEnsurer.ensureFileId).not.toHaveBeenCalled()
  })

  // Delegation.

  it('delegates to the shared ensurer and returns its id', async () => {
    fileRowEnsurer.ensureFileId.mockResolvedValue(555)
    const result = await service.ensure(fsFile({ id: -987654 }), personalSpace(), user)
    expect(result).toBe(555)
    expect(fileRowEnsurer.ensureFileId).toHaveBeenCalledTimes(1)
  })

  it('ensures dir rows just like file rows (regression for #209: no abs(inode) collisions)', async () => {
    // Pre-fix behavior: dirs short-circuited and emitted abs(inode) as oc:id.
    // Inode N could collide with a real DB id N from a file in the same
    // listing — NC mobile cache would overwrite one entity's metadata with
    // the other's. Now dirs flow through the same lookup-then-insert path.
    fileRowEnsurer.ensureFileId.mockResolvedValue(321)
    const f = fsFile({ id: -123, isDir: true, path: 'Photos', name: 'Subfolder' })
    const result = await service.ensure(f, personalSpace(), user)
    expect(result).toBe(321)
    const [, , props] = fileRowEnsurer.ensureFileId.mock.calls[0]
    expect(props).toMatchObject({ isDir: true, path: 'Photos', name: 'Subfolder' })
  })

  // URL-path normalization — depth-0 file PROPFIND bug.
  // webdavSpaces.listFiles calls getProps(realPath, req.dav.url) for the root
  // entry; req.dav.url is the full NC path so dirName gives a URL-prefixed
  // path like /remote.php/dav/files/alice/Photos instead of Photos.

  it('corrects a URL-prefixed path to the in-space path via space.relativeUrl', async () => {
    fileRowEnsurer.ensureFileId.mockResolvedValue(555)
    const space = { inPersonalSpace: true, inTrashRepository: false, relativeUrl: 'Photos/cat.jpg' } as unknown as SpaceEnv
    const f = fsFile({ id: -987654, path: '/remote.php/dav/files/alice/Photos', name: 'cat.jpg' })
    const result = await service.ensure(f, space, user)
    expect(result).toBe(555)
    const [, , props] = fileRowEnsurer.ensureFileId.mock.calls[0]
    expect(props.path).toBe('Photos')
  })

  it('corrects a root-level file (relativeUrl has no dir component → path becomes .)', async () => {
    fileRowEnsurer.ensureFileId.mockResolvedValue(42)
    const space = { inPersonalSpace: true, inTrashRepository: false, relativeUrl: 'cat.jpg' } as unknown as SpaceEnv
    const f = fsFile({ id: -987654, path: '/remote.php/dav/files/alice', name: 'cat.jpg' })
    const result = await service.ensure(f, space, user)
    expect(result).toBe(42)
    const [, , props] = fileRowEnsurer.ensureFileId.mock.calls[0]
    expect(props.path).toBe('.')
  })

  it('leaves an already in-space path untouched', async () => {
    fileRowEnsurer.ensureFileId.mockResolvedValue(7)
    const f = fsFile({ id: -987654, path: 'Photos', name: 'cat.jpg' })
    await service.ensure(f, personalSpace(), user)
    const [, , props] = fileRowEnsurer.ensureFileId.mock.calls[0]
    expect(props.path).toBe('Photos')
  })

  // Failure mode — graceful degrade. The shared ensurer swallows DB errors and
  // returns 0; we must map that back to the placeholder rather than emit 0.

  it('falls back to f.id when the shared ensurer cannot resolve an id (PROPFIND must not fail)', async () => {
    fileRowEnsurer.ensureFileId.mockResolvedValue(0)
    const result = await service.ensure(fsFile({ id: -987654 }), personalSpace(), user)
    expect(result).toBe(-987654)
  })
})
