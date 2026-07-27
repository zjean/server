// Mock the config singleton before anything imports UserModel / VersioningService,
// both of which read it at module load. Same pattern as
// custom-versioning/services/versioning.service.spec.ts.
vi.mock('../../../configuration/config.environment', () => ({
  configuration: {
    applications: {
      files: {
        dataPath: '',
        usersPath: '',
        spacesPath: '',
        tmpPath: '',
        versions: { enabled: true, maxVersionsPerFile: 20, retentionDays: { users: false, spaces: false }, quotaShare: 0.5, minIntervalSeconds: 60 }
      }
    }
  },
  serverConfig: {},
  exportConfiguration: vi.fn()
}))

import { Test } from '@nestjs/testing'
import { Mock } from 'vitest'
import { FileError } from '../../files/models/file-error'
import { FilesQueries } from '../../files/services/files-queries.service'
import type { SpaceEnv } from '../../spaces/models/space-env.model'
import { SpacesManager } from '../../spaces/services/spaces-manager.service'
import type { UserModel } from '../../users/models/user.model'
import type { VersionProps } from '../../custom-versioning/interfaces/version.interface'
import { VersioningService } from '../../custom-versioning/services/versioning.service'
import { NcVersionsService, ncContentType, ncRevisionOf } from './nc-versions.service'

const USER = { id: 7, login: 'alice' } as UserModel

// 2025-07-20T10:00:00.000Z and 09:50:00.000Z
const NEWER_MS = 1_753_005_600_000
const OLDER_MS = 1_753_005_000_000

function version(overrides: Partial<VersionProps> = {}): VersionProps {
  return {
    id: 11,
    fileId: 4242,
    size: 1234,
    mtime: NEWER_MS,
    createdAt: new Date('2026-07-27T08:00:00.000Z'),
    origin: 'web',
    label: null,
    checksum: 'a'.repeat(64),
    author: { login: 'alice', fullName: 'Alice Liddell' },
    ...overrides
  }
}

function space(realPath = '/data/users/alice/files/docs/report.txt'): SpaceEnv {
  return { realPath, dbFile: { ownerId: 7, path: 'docs/report.txt', inTrash: false } } as unknown as SpaceEnv
}

describe(NcVersionsService.name, () => {
  let service: NcVersionsService
  let getUserFile: Mock
  let spaceEnv: Mock
  let listVersions: Mock

  beforeEach(async () => {
    getUserFile = vi.fn()
    spaceEnv = vi.fn()
    listVersions = vi.fn().mockResolvedValue([])

    const moduleRef = await Test.createTestingModule({
      providers: [
        NcVersionsService,
        { provide: FilesQueries, useValue: { getUserFile } },
        { provide: SpacesManager, useValue: { spaceEnv } },
        { provide: VersioningService, useValue: { listVersions, enabled: true } }
      ]
    }).compile()
    moduleRef.useLogger(['fatal'])
    service = moduleRef.get(NcVersionsService)
  })

  describe('ncRevisionOf', () => {
    // Forced from two directions: upstream's revision id IS a timestamp (the
    // legacy backend names the stored file `<path>.v<filemtime>`,
    // Storage.php:374), and Android derives the restore MOVE source from
    // getlastmodified / 1000 rather than from the href.
    it('is the superseded content’s mtime in unix SECONDS, not the row id', () => {
      expect(ncRevisionOf({ mtime: NEWER_MS })).toBe(1_753_005_600)
      expect(ncRevisionOf({ mtime: NEWER_MS })).not.toBe(11)
    })

    it('floors sub-second precision rather than rounding', () => {
      expect(ncRevisionOf({ mtime: NEWER_MS + 999 })).toBe(1_753_005_600)
    })
  })

  describe('ncContentType', () => {
    // Sync-in replaces only the FIRST '/' (getMimeType uses replace, not
    // replaceAll), so later dashes belong to the subtype and must survive.
    it('translates the stored single-dash form back to a real mime', () => {
      expect(ncContentType('/x/photo.jpg')).toBe('image/jpeg')
      expect(ncContentType('/x/notes.txt')).toBe('text/plain')
    })

    it('keeps dashes that are part of the subtype', () => {
      // A dash-bearing subtype must not become a second slash.
      const result = ncContentType('/x/archive.tar.bz2')
      expect(result.match(/\//g)).toHaveLength(1)
    })

    // getMimeType returns the sentinel 'file' for an unknown extension. Emitting
    // that verbatim would put a non-mime in d:getcontenttype.
    it('maps the unknown-extension sentinel to a real generic mime', () => {
      expect(ncContentType('/x/blob.unknown-extension-xyz')).toBe('application/octet-stream')
    })
  })

  describe('resolveSpace', () => {
    // The lookup IS the authorization step: getUserFile is scoped to
    // ownerId = user.id, so a file the requester does not own never resolves.
    // Same constraint (and same reason) as nc-comments and the OnlyOffice
    // resolver: personal-space files only.
    it('resolves an owned file to its personal-space env', async () => {
      getUserFile.mockResolvedValue({ id: 4242, path: 'docs/report.txt' })
      spaceEnv.mockResolvedValue(space())

      await expect(service.resolveSpace(USER, 4242)).resolves.toEqual(space())
      expect(getUserFile).toHaveBeenCalledWith(7, 4242)
      expect(spaceEnv).toHaveBeenCalledWith(USER, ['files', 'personal', 'docs', 'report.txt'])
    })

    it.each([
      ['the file is not owned by the requester', async () => getUserFile.mockResolvedValue(null)],
      ['the row carries no path', async () => getUserFile.mockResolvedValue({ id: 4242, path: '' })],
      ['the lookup throws', async () => getUserFile.mockRejectedValue(new Error('db down'))],
      [
        'the space env cannot be built',
        async () => {
          getUserFile.mockResolvedValue({ id: 4242, path: 'docs/report.txt' })
          spaceEnv.mockRejectedValue(new Error('nope'))
        }
      ],
      [
        'the space env resolves to nothing',
        async () => {
          getUserFile.mockResolvedValue({ id: 4242, path: 'docs/report.txt' })
          spaceEnv.mockResolvedValue(undefined)
        }
      ]
    ])('returns null when %s', async (_label, arrange) => {
      await arrange()
      await expect(service.resolveSpace(USER, 4242)).resolves.toBeNull()
    })
  })

  describe('listEntries', () => {
    it('maps each version onto the wire shape, preserving the service’s newest-first order', async () => {
      listVersions.mockResolvedValue([
        version({ id: 12, mtime: NEWER_MS, size: 20, label: 'named' }),
        version({ id: 11, mtime: OLDER_MS, size: 10, author: undefined })
      ])

      const entries = await service.listEntries(USER, space())

      expect(entries).toEqual([
        { revision: 1_753_005_600, mtimeMs: NEWER_MS, size: 20, contentType: 'text/plain', label: 'named', author: 'alice' },
        { revision: 1_753_005_000, mtimeMs: OLDER_MS, size: 10, contentType: 'text/plain', label: null, author: null }
      ])
    })

    // The NC protocol has one-second resolution because the revision id IS the
    // timestamp — upstream cannot represent two versions in the same second
    // either (both would want the same `.v<ts>` filename). Emitting two entries
    // the client cannot tell apart is worse than collapsing them: Android would
    // build an identical restore URL for both. The v2 UI keys on the row id and
    // still shows both.
    it('collapses versions that share a unix second, keeping the newest', async () => {
      listVersions.mockResolvedValue([version({ id: 12, mtime: NEWER_MS + 400, size: 99 }), version({ id: 11, mtime: NEWER_MS + 100, size: 50 })])

      const entries = await service.listEntries(USER, space())

      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ revision: 1_753_005_600, size: 99 })
    })

    it('returns an empty list for a file with no history', async () => {
      await expect(service.listEntries(USER, space())).resolves.toEqual([])
    })
  })

  describe('requireVersionId', () => {
    it('maps a revision back to the row id the versioning service wants', async () => {
      listVersions.mockResolvedValue([version({ id: 12, mtime: NEWER_MS }), version({ id: 11, mtime: OLDER_MS })])
      await expect(service.requireVersionId(USER, space(), 1_753_005_000)).resolves.toBe(11)
    })

    // FileError, not null: the controller's exception filter already translates
    // it, so "unknown revision" comes out as the same 404 as every other
    // not-found the versioning service raises.
    it('throws a 404 FileError for an unknown revision', async () => {
      listVersions.mockResolvedValue([version()])
      await expect(service.requireVersionId(USER, space(), 1)).rejects.toBeInstanceOf(FileError)
      await expect(service.requireVersionId(USER, space(), 1)).rejects.toMatchObject({ httpCode: 404 })
    })

    it('resolves a collapsed second to the same row the listing showed', async () => {
      listVersions.mockResolvedValue([version({ id: 12, mtime: NEWER_MS + 400 }), version({ id: 11, mtime: NEWER_MS + 100 })])
      await expect(service.requireVersionId(USER, space(), 1_753_005_600)).resolves.toBe(12)
    })
  })

  describe('findEntry', () => {
    it('returns the single entry for a revision', async () => {
      listVersions.mockResolvedValue([version({ id: 11, mtime: OLDER_MS, size: 10 })])
      await expect(service.findEntry(USER, space(), 1_753_005_000)).resolves.toMatchObject({ revision: 1_753_005_000, size: 10 })
    })

    it('returns null for an unknown revision', async () => {
      await expect(service.findEntry(USER, space(), 1)).resolves.toBeNull()
    })
  })

  it('mirrors the versioning service’s flag rather than reading config itself', () => {
    // One source of truth: the capability block and every handler have to agree
    // with the service, and they do because they all ask the same object.
    expect(service.enabled).toBe(true)
  })
})
