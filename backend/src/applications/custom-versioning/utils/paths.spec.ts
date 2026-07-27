// Config singleton must be mocked before UserModel/SpaceModel read it at load.
vi.mock('../../../configuration/config.environment', () => ({
  configuration: {
    applications: {
      files: {
        dataPath: '/data',
        usersPath: '/data/users',
        spacesPath: '/data/spaces',
        tmpPath: '/data/tmp'
      }
    }
  },
  serverConfig: {},
  exportConfiguration: vi.fn()
}))

import path from 'node:path'
import { SPACE_REPOSITORY } from '../../spaces/constants/spaces'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { SpaceModel } from '../../spaces/models/space.model'
import { UserModel } from '../../users/models/user.model'
import { isPathInside } from '../../files/utils/files'
import { blobPathFromRoot, spaceVersionsRoot, userVersionsRoot, versionsPathFromRoot, versionsRootFromSpace } from './paths'

const user = { id: 7, login: 'alice' } as unknown as UserModel

function env(over: Partial<SpaceEnv> = {}): SpaceEnv {
  return {
    inPersonalSpace: false,
    inFilesRepository: true,
    inSharesRepository: false,
    inTrashRepository: false,
    alias: 'team',
    ...over
  } as unknown as SpaceEnv
}

describe('versions path resolution', () => {
  /* ------------------------------------------------------- root resolution */

  // Mirrors realTrashPathFromSpace branch for branch (ADR §1). Trash is the
  // proven precedent for "where does out-of-tree data for this space env
  // belong", so a divergence here is a bug, not a simplification.
  it('resolves a personal space to the user root', () => {
    expect(versionsRootFromSpace(user, env({ inPersonalSpace: true, alias: 'personal' }))).toBe('user:alice')
  })

  it('resolves a plain space to the space root', () => {
    expect(versionsRootFromSpace(user, env())).toBe('space:team')
  })

  it('resolves a space root with an external path to the space root', () => {
    const space = env({ root: { externalPath: '/mnt/ext' } as any })
    expect(versionsRootFromSpace(user, space)).toBe('space:team')
  })

  it('resolves an external-path SHARE to the acting user root, because such a share has no owner', () => {
    const space = env({
      inFilesRepository: false,
      inSharesRepository: true,
      root: { externalPath: '/mnt/ext' } as any
    })
    expect(versionsRootFromSpace(user, space)).toBe('user:alice')
  })

  it('resolves a space root anchored to a personal file to that file owner’s root', () => {
    const space = env({ root: { file: { path: 'docs' }, owner: { id: 2, login: 'bob' } } as any })
    expect(versionsRootFromSpace(user, space)).toBe('user:bob')
  })

  it('resolves a share of a space file to that space’s root', () => {
    const space = env({ root: { file: { space: { id: 3, alias: 'other' } } } as any })
    expect(versionsRootFromSpace(user, space)).toBe('space:other')
  })

  // Regression: `space.id` can be set while `alias` is not. Returning
  // 'space:undefined' would write blobs to <spacesPath>/undefined; upstream's
  // mirrored trash function would throw on path.join(undefined). Null means
  // "skip versioning", which is this function's documented contract.
  it('returns null when a shared space has an id but no alias', () => {
    const space = env({ root: { file: { space: { id: 3 } } } as any })
    expect(versionsRootFromSpace(user, space)).toBeNull()
  })

  it('returns null when nothing identifies a root', () => {
    expect(versionsRootFromSpace(user, env({ alias: undefined }))).toBeNull()
  })

  /* ----------------------------------------------- THE ISOLATION INVARIANT */

  // This is the guard that keeps the whole feature invisible to the rest of the
  // system, and it is purely a consequence of WHERE the store sits.
  //
  // The content indexer walks with a plain readdir and has NO dotfolder or
  // name-based exclusion (files-content-indexer.service.ts). WebDAV PROPFIND
  // and the desktop sync diff both enumerate from the same files-repository
  // roots. So nothing filters the blob store out — it is unseen only because it
  // is a SIBLING of files/, never inside it.
  //
  // If anyone ever "simplifies" the store to a `.versions` directory inside the
  // files root, this test fails, and that is the point.
  describe.each([
    ['user', userVersionsRoot('alice'), UserModel.getFilesPath('alice'), UserModel.getTrashPath('alice'), UserModel.getHomePath('alice')],
    ['space', spaceVersionsRoot('team'), SpaceModel.getFilesPath('team'), SpaceModel.getTrashPath('team'), SpaceModel.getHomePath('team')]
  ])('%s root', (_label, versionsRoot, filesPath, trashPath, homePath) => {
    const versionsPath = versionsPathFromRoot(versionsRoot)

    it('is not inside the files repository, so the indexer, PROPFIND and sync never see it', () => {
      expect(versionsPath).not.toBeNull()
      expect(isPathInside(filesPath, versionsPath!, true)).toBe(false)
    })

    it('sits beside files/ and trash/ under the same home, exactly like trash', () => {
      expect(versionsPath).toBe(path.join(homePath, 'versions'))
      expect(path.dirname(versionsPath!)).toBe(path.dirname(filesPath))
      expect(path.dirname(versionsPath!)).toBe(path.dirname(trashPath))
    })

    it('is not the trash repository either, so trash retention does not scan it', () => {
      expect(versionsPath).not.toBe(trashPath)
      expect(isPathInside(trashPath, versionsPath!, true)).toBe(false)
    })
  })

  // `versions` must never become URL-reachable. Unlike trash, which IS
  // browsable, the store has no space alias and no repository entry.
  it('is not a space repository, so no URL can address it', () => {
    expect(Object.values(SPACE_REPOSITORY)).toEqual(['files', 'trash', 'shares'])
    expect(Object.values(SPACE_REPOSITORY)).not.toContain('versions')
  })

  /* ------------------------------------------------------------ blob paths */

  it('shards blobs by the first two digest characters', () => {
    const digest = 'ab' + 'c'.repeat(62)
    expect(blobPathFromRoot(userVersionsRoot('alice'), digest)).toBe(path.join('/data/users/alice/versions', 'ab', digest))
  })

  // The checksum arrives from a DB row, so it is still untrusted input at the
  // point it becomes a path.
  it.each([
    ['a traversal attempt', '../../../../etc/passwd'],
    ['a separator', 'ab/cd'],
    ['upper-case hex', 'A'.repeat(64)],
    ['too short', 'ab'],
    ['too long', 'a'.repeat(65)],
    ['empty', '']
  ])('refuses %s as a digest', (_label, digest) => {
    expect(blobPathFromRoot(userVersionsRoot('alice'), digest)).toBeNull()
  })

  it('refuses an unrecognized or empty root discriminator', () => {
    const digest = 'a'.repeat(64)
    expect(blobPathFromRoot('nonsense:alice', digest)).toBeNull()
    expect(blobPathFromRoot('user:', digest)).toBeNull()
    expect(blobPathFromRoot('space:', digest)).toBeNull()
    expect(versionsPathFromRoot('nonsense')).toBeNull()
  })

  // A stored versionsRoot is a database value, so it is still untrusted where it
  // becomes a filesystem path. Returning null — never throwing — is what lets
  // the download and restore endpoints answer 404 instead of leaking a raw 500.
  it.each([
    ['a login traversal', 'user:../../etc'],
    ['a login separator', 'user:a/b'],
    ['a login backslash', 'user:a\\b'],
    ['a dot login', 'user:.'],
    ['an alias traversal', 'space:..'],
    ['an alias separator', 'space:a/b']
  ])('returns null rather than throwing for %s', (_label, root) => {
    expect(() => versionsPathFromRoot(root)).not.toThrow()
    expect(versionsPathFromRoot(root)).toBeNull()
    expect(blobPathFromRoot(root, 'a'.repeat(64))).toBeNull()
  })
})
