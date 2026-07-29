import { HttpService } from '@nestjs/axios'
import { HttpException, HttpStatus } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Test, TestingModule } from '@nestjs/testing'
import { AxiosResponse } from 'axios'
import { Readable } from 'stream'
import { Mocked } from 'vitest'
import { TOKEN_TYPE } from '../../../../authentication/interfaces/token.interface'
import { configuration } from '../../../../configuration/config.environment'
import { Cache } from '../../../../infrastructure/cache/cache.service'
import { ContextManager } from '../../../../infrastructure/context/services/context-manager.service'
import type { SpaceEnv } from '../../../spaces/models/space-env.model'
import type { UserModel } from '../../../users/models/user.model'
import { ACTION } from '../../../../common/constants'
import { DEPTH, LOCK_SCOPE } from '../../../webdav/constants/webdav'
import { FILE_MODE } from '../../constants/operations'
import { FileEvent } from '../../events/file-events'
import { LockConflict } from '../../models/file-lock-error'
import { FilesLockManager } from '../../services/files-lock-manager.service'
import * as filesUtils from '../../utils/files'
import { OnlyOfficeManager } from './only-office-manager.service'
import { ONLY_OFFICE_APP_LOCK } from './only-office.constants'
import { VersioningService } from '../../../custom-versioning/services/versioning.service'

vi.mock('../../utils/files')
vi.mock('../../../users/utils/avatar', () => ({
  getAvatarBase64: vi.fn().mockResolvedValue('data:image/png;base64,iVBORw0KGgo=')
}))

// Fork: versioning hooks. Stubbed so these suites keep asserting upstream
// behavior; the hooks' own assertions live alongside each write path below.
const versioning = {
  snapshotBeforeOverwrite: vi.fn().mockResolvedValue(undefined),
  purgeForPath: vi.fn().mockResolvedValue(undefined),
  purgeForFile: vi.fn().mockResolvedValue(undefined)
}

describe(OnlyOfficeManager.name, () => {
  let service: OnlyOfficeManager
  let cache: Mocked<Cache>
  let httpService: Mocked<HttpService>
  let jwtService: Mocked<JwtService>
  let filesLockManager: Mocked<FilesLockManager>
  let onlyOfficeEnabled: boolean
  let onlyOfficeExternalServer: string

  const mockUser = {
    id: 1,
    login: 'testuser',
    email: 'test@example.com',
    fullName: 'Test User',
    language: 'en',
    role: 'user',
    applications: []
  } as unknown as UserModel

  const mockSpaceEnv = {
    realPath: '/real/path/document.docx',
    relativeUrl: '/document.docx',
    url: 'space/document.docx',
    dbFile: {
      directory: '/space',
      name: 'document.docx',
      storageId: 1,
      storageTypeId: 1
    },
    permissions: 'r,m,d',
    envPermissions: 'r,m,d'
  } as unknown as SpaceEnv

  const mockRequest = {
    headers: {
      'user-agent': 'Mozilla/5.0'
    }
  } as any

  beforeEach(async () => {
    onlyOfficeEnabled = configuration.applications.files.editors.onlyoffice.enabled
    onlyOfficeExternalServer = configuration.applications.files.editors.onlyoffice.externalServer
    configuration.applications.files.editors.onlyoffice.enabled = true
    configuration.applications.files.editors.onlyoffice.externalServer = null

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OnlyOfficeManager,
        { provide: VersioningService, useValue: versioning },
        {
          provide: Cache,
          useValue: {
            get: vi.fn(),
            set: vi.fn(),
            del: vi.fn()
          }
        },
        {
          provide: HttpService,
          useValue: {
            axiosRef: vi.fn()
          }
        },
        {
          provide: JwtService,
          useValue: {
            signAsync: vi.fn(),
            verifyAsync: vi.fn()
          }
        },
        {
          provide: ContextManager,
          useValue: {
            headerOriginUrl: vi.fn().mockReturnValue('http://localhost:3000')
          }
        },
        {
          provide: FilesLockManager,
          useValue: {
            checkConflicts: vi.fn(),
            convertLockToFileLockProps: vi.fn(),
            create: vi.fn(),
            getLocksByPath: vi.fn(),
            removeLock: vi.fn(),
            isPathLocked: vi.fn()
          }
        }
      ]
    }).compile()

    module.useLogger(['fatal'])
    service = module.get<OnlyOfficeManager>(OnlyOfficeManager)
    cache = module.get(Cache)
    httpService = module.get(HttpService)
    jwtService = module.get(JwtService)
    filesLockManager = module.get(FilesLockManager)
  })

  afterEach(() => {
    configuration.applications.files.editors.onlyoffice.enabled = onlyOfficeEnabled
    configuration.applications.files.editors.onlyoffice.externalServer = onlyOfficeExternalServer
    vi.clearAllMocks()
  })

  describe('getSettings', () => {
    beforeEach(() => {
      vi.mocked(filesUtils.isPathExists).mockResolvedValue(true)
      vi.mocked(filesUtils.isPathIsDir).mockResolvedValue(false)
      filesLockManager.checkConflicts.mockResolvedValue(undefined)
      jwtService.signAsync.mockResolvedValue('mock-token')
      cache.get.mockResolvedValue(null)
      cache.set.mockResolvedValue(undefined)
      vi.mocked(filesUtils.genEtag).mockReturnValue('mock-etag')
    })

    it('should return OnlyOffice settings for editable document', async () => {
      const result = await service.getSettings(mockUser, mockSpaceEnv, mockRequest)

      expect(result).toBeDefined()
      expect(result.config.documentType).toBe('word')
      expect(result.config.editorConfig.mode).toBe(FILE_MODE.EDIT)
      expect(result.config.document.permissions.edit).toBe(true)
      expect(result.hasLock).toBe(false)
      expect(jwtService.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          tokenType: TOKEN_TYPE.ONLY_OFFICE
        }),
        expect.any(Object)
      )
    })

    it('should throw error if document does not exist', async () => {
      vi.mocked(filesUtils.isPathExists).mockResolvedValue(false)

      await expect(service.getSettings(mockUser, mockSpaceEnv, mockRequest)).rejects.toThrow(
        new HttpException('Document not found', HttpStatus.BAD_REQUEST)
      )
    })

    it('should throw error if path is a directory', async () => {
      vi.mocked(filesUtils.isPathIsDir).mockResolvedValue(true)

      await expect(service.getSettings(mockUser, mockSpaceEnv, mockRequest)).rejects.toThrow(
        new HttpException('Document must be a file', HttpStatus.BAD_REQUEST)
      )
    })

    it('should throw error if document extension is not supported', async () => {
      const unsupportedSpaceEnv = {
        ...mockSpaceEnv,
        realPath: '/real/path/document.xyz'
      } as unknown as SpaceEnv

      await expect(service.getSettings(mockUser, unsupportedSpaceEnv, mockRequest)).rejects.toThrow(
        new HttpException('Document not supported', HttpStatus.BAD_REQUEST)
      )
    })

    it('should set mode to VIEW when file has lock conflict', async () => {
      const mockLock = {
        key: 'lock-key',
        app: ONLY_OFFICE_APP_LOCK,
        owner: { id: 2, login: 'otheruser' }
      } as any
      const lockError = new LockConflict(mockLock, 'File is locked')
      filesLockManager.checkConflicts.mockRejectedValue(lockError)
      filesLockManager.convertLockToFileLockProps.mockReturnValue({
        owner: { id: 2, login: 'otheruser' }
      } as any)

      const result = await service.getSettings(mockUser, mockSpaceEnv, mockRequest)

      expect(result.config.editorConfig.mode).toBe(FILE_MODE.VIEW)
      expect(result.config.document.permissions.edit).toBe(false)
      expect(result.hasLock).toBeDefined()
    })

    it('should set mode to VIEW when user does not have modify permissions', async () => {
      const viewOnlySpaceEnv = {
        ...mockSpaceEnv,
        permissions: 'r',
        envPermissions: 'r'
      } as unknown as SpaceEnv

      const result = await service.getSettings(mockUser, viewOnlySpaceEnv, mockRequest)

      expect(result.config.editorConfig.mode).toBe(FILE_MODE.VIEW)
      expect(result.config.document.permissions.edit).toBe(false)
    })

    it('should set mode to VIEW when document is in trash repository', async () => {
      const trashSpaceEnv = {
        ...mockSpaceEnv,
        inTrashRepository: true
      } as unknown as SpaceEnv

      const result = await service.getSettings(mockUser, trashSpaceEnv, mockRequest)

      expect(result.config.editorConfig.mode).toBe(FILE_MODE.VIEW)
      expect(result.config.document.permissions.edit).toBe(false)
      expect(filesLockManager.checkConflicts).not.toHaveBeenCalled()
    })

    it('should detect mobile user agent', async () => {
      const mobileRequest = {
        headers: {
          'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)'
        }
      } as any

      const result = await service.getSettings(mockUser, mockSpaceEnv, mobileRequest)

      expect(result.config.type).toBe('mobile')
    })

    it('should use cached document key', async () => {
      cache.get.mockResolvedValue('cached-doc-key')

      const result = await service.getSettings(mockUser, mockSpaceEnv, mockRequest)

      expect(result.config.document.key).toBe('cached-doc-key')
      expect(cache.set).not.toHaveBeenCalled()
    })
  })

  describe('callBack', () => {
    const mockToken = 'mock-callback-token'
    const mockDocumentUrl = 'http://localhost:3000/onlyoffice/document.docx?md5=abc123&expires=1739400549&shardkey=-33120641&filename=document.docx'

    beforeEach(() => {
      filesLockManager.removeLock.mockResolvedValue(undefined)
      filesLockManager.getLocksByPath.mockResolvedValue([])
      filesLockManager.isPathLocked.mockResolvedValue(false)
      cache.del.mockResolvedValue(true)
      vi.mocked(filesUtils.uniqueFilePathFromDir).mockResolvedValue('/tmp/temp-file.docx')
      vi.mocked(filesUtils.writeFromStream).mockResolvedValue(undefined)
      vi.mocked(filesUtils.fileSize).mockResolvedValue(12)
      vi.mocked(filesUtils.copyFileContent).mockResolvedValue(undefined)
      vi.mocked(filesUtils.removeFiles).mockResolvedValue(undefined)
    })

    const mockSuccessfulDownload = () => {
      httpService.axiosRef.mockResolvedValue({
        data: Readable.from(['mock content']),
        headers: { 'content-length': '12' },
        status: 200,
        statusText: 'OK',
        config: {} as any
      } as AxiosResponse)
    }

    const expectSuccessfulSaveCallback = async (url: string, callbackData: Record<string, any> = {}) => {
      const emitSpy = vi.spyOn(FileEvent, 'emit')
      jwtService.verifyAsync.mockResolvedValue({
        status: 2,
        actions: [],
        users: [],
        notmodified: false,
        url,
        ...callbackData
      })
      mockSuccessfulDownload()

      const result = await service.callBack(mockUser, mockSpaceEnv, mockToken)

      expect(result).toEqual({ error: 0 })
      expect(emitSpy).toHaveBeenCalledWith('event', {
        user: mockUser,
        space: mockSpaceEnv,
        action: ACTION.UPDATE,
        rPath: mockSpaceEnv.realPath,
        source: 'editor'
      })
      expect(httpService.axiosRef).toHaveBeenCalledWith(expect.objectContaining({ url, maxRedirects: 0 }))
    }

    it('should allow internal container document downloads when external server is not configured', async () => {
      const internalDocumentUrl = 'http://onlyoffice/document.docx?md5=abc123&expires=1739400549&shardkey=-33120641&filename=document.docx'
      await expectSuccessfulSaveCallback(internalDocumentUrl)
    })

    it('should allow document downloads from the external server origin with a rewritten path', async () => {
      ;(service as any).externalOnlyOfficeServer = 'https://office.example.com/onlyoffice'
      const rewrittenPathUrl =
        'https://office.example.com/cache/files/document.docx?md5=abc123&expires=1739400549&shardkey=-33120641&filename=document.docx'
      await expectSuccessfulSaveCallback(rewrittenPathUrl)
    })

    // Fork: versioning. This editor bypasses saveStream, so copyFileContent is
    // the destructive moment. The acting user arrives as a parameter here
    // rather than on a request.
    it('snapshots the previous content before a save callback, tagged onlyoffice', async () => {
      await expectSuccessfulSaveCallback('http://onlyoffice/document.docx?md5=abc123&expires=1739400549&shardkey=-33120641&filename=document.docx')

      expect(versioning.snapshotBeforeOverwrite).toHaveBeenCalledTimes(1)
      expect(versioning.snapshotBeforeOverwrite).toHaveBeenCalledWith(mockUser, mockSpaceEnv, { origin: 'onlyoffice', saveKind: 'interactive' })
    })

    it('does not snapshot when the document closed with no changes (status 2, notmodified)', async () => {
      jwtService.verifyAsync.mockResolvedValue({ status: 2, actions: [], users: [], notmodified: true })

      await service.callBack(mockUser, mockSpaceEnv, mockToken)

      expect(versioning.snapshotBeforeOverwrite).not.toHaveBeenCalled()
    })

    it('does not snapshot on a status 1 connect/disconnect callback', async () => {
      // Status 1 never saves, so it must never version — this is why editor
      // coalescing rarely fires for OnlyOffice.
      jwtService.verifyAsync.mockResolvedValue({ status: 1, actions: [{ type: 1, userid: '1' }], users: ['1'] })

      await service.callBack(mockUser, mockSpaceEnv, mockToken)

      expect(versioning.snapshotBeforeOverwrite).not.toHaveBeenCalled()
    })

    /* Fork: versioning — task D4, the OnlyOffice half.
       ADR §5 asserts the cadence from source rather than measuring it: only
       statuses 2 (modified), 3, 6 and 7 reach saveDocument, and there is NO
       autosave-per-keystroke path, so coalescing is expected to rarely fire for
       this editor. That claim was prose. This is the exhaustive form of it, and
       it is exhaustive on purpose: a new status arm added upstream that saves
       shows up here as a surprise, which is the only way the "cadence is known"
       claim can stay true across a sync. */
    describe('the complete set of statuses that version (D4)', () => {
      const SAVING_STATUSES = [
        [2, { notmodified: false }, 'closed with unsaved changes'],
        [3, {}, 'save error, retried'],
        [6, {}, 'forcesave'],
        [7, {}, 'forcesave error, retried']
      ] as const

      const NON_SAVING_STATUSES = [
        [1, { actions: [{ type: 1, userid: '1' }], users: ['1'] }, 'users connect / disconnect'],
        [2, { notmodified: true }, 'closed with no changes'],
        [4, { actions: [] }, 'closed with no changes']
      ] as const

      it.each(SAVING_STATUSES)('status %i (%s) versions exactly once', async (status, extra) => {
        await expectSuccessfulSaveCallback(mockDocumentUrl, { status, ...extra })
        expect(versioning.snapshotBeforeOverwrite).toHaveBeenCalledTimes(1)
        expect(versioning.snapshotBeforeOverwrite).toHaveBeenCalledWith(mockUser, mockSpaceEnv, expect.objectContaining({ origin: 'onlyoffice' }))
      })

      it.each(NON_SAVING_STATUSES)('status %i (%s) never versions', async (status, extra) => {
        jwtService.verifyAsync.mockResolvedValue({ status, actions: [], users: [], ...extra })

        await service.callBack(mockUser, mockSpaceEnv, mockToken)

        expect(versioning.snapshotBeforeOverwrite).not.toHaveBeenCalled()
      })
    })

    /* Fork: versioning — #389. The coalescing window keys on WHO triggered the
       save, and `forcesavetype` is the only thing on the wire that says.

       Exhaustive on purpose, for the same reason the status table above is: the
       classification is a claim about an upstream contract, and the contract
       says `forcesavetype` is present on statuses 6 and 7 ONLY. Statuses 2 and
       3 are therefore permanently unclassifiable, as is a status-6 body that
       omits the field despite the contract — all three default to
       `interactive`, because a status-2 flush is the tail of a human session
       and a status-3 retry is a human save being re-attempted. Erring toward
       keeping a revision is the direction this feature should fail in.

       See docs/plans/2026-07-29-coalescing-forcesavetype-design.md §2.2. */
    describe('classifying a save as human or automatic (#389)', () => {
      const CLASSIFICATIONS = [
        [6, { forcesavetype: 1 }, 'interactive', 'the Save button was clicked'],
        [6, { forcesavetype: 3 }, 'interactive', 'the form was submitted'],
        [6, { forcesavetype: 2 }, 'automatic', 'by the document server timer'],
        [6, { forcesavetype: 0 }, 'automatic', 'via the command service'],
        [6, {}, 'interactive', 'forcesavetype absent where the contract says it cannot be'],
        [7, { forcesavetype: 1 }, 'interactive', 'a human save, retried after an error'],
        [7, { forcesavetype: 2 }, 'automatic', 'a timer save, retried after an error'],
        [2, { notmodified: false }, 'interactive', 'session-close flush, no discriminator'],
        [3, {}, 'interactive', 'save-error retry, trigger already lost']
      ] as const

      it.each(CLASSIFICATIONS)('status %i %o -> %s (%s)', async (status, extra, saveKind) => {
        await expectSuccessfulSaveCallback(mockDocumentUrl, { status, ...extra })

        expect(versioning.snapshotBeforeOverwrite).toHaveBeenCalledWith(mockUser, mockSpaceEnv, { origin: 'onlyoffice', saveKind })
      })
    })

    it('should handle status 2 (document closed without changes)', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        status: 2,
        actions: [],
        users: [],
        notmodified: true
      })

      const result = await service.callBack(mockUser, mockSpaceEnv, mockToken)

      expect(result).toEqual({ error: 0 })
      expect(httpService.axiosRef).not.toHaveBeenCalled()
    })

    it('should handle status 3 (error saving document)', async () => {
      await expectSuccessfulSaveCallback(mockDocumentUrl, { status: 3 })
    })

    it('should handle status 4 (document closed with no changes)', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        status: 4,
        actions: []
      })

      const result = await service.callBack(mockUser, mockSpaceEnv, mockToken)

      expect(result).toEqual({ error: 0 })
    })

    it('should handle status 6 (force save)', async () => {
      await expectSuccessfulSaveCallback(mockDocumentUrl, { status: 6 })
    })

    it('should handle status 7 (error force saving)', async () => {
      await expectSuccessfulSaveCallback(mockDocumentUrl, { status: 7 })
    })

    it('should handle user connect action (type 1)', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        status: 1,
        actions: [{ type: 1, userid: '1' }],
        users: ['1']
      })
      filesLockManager.create.mockResolvedValue([true, {} as any])

      const result = await service.callBack(mockUser, mockSpaceEnv, mockToken)

      expect(result).toEqual({ error: 0 })
      expect(filesLockManager.create).toHaveBeenCalledWith(
        mockUser,
        mockSpaceEnv.dbFile,
        ONLY_OFFICE_APP_LOCK,
        DEPTH.RESOURCE,
        {
          lockRoot: null,
          lockToken: null,
          lockScope: LOCK_SCOPE.SHARED
        },
        expect.any(Number)
      )
    })

    it('should handle user disconnect action (type 0)', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        status: 1,
        actions: [{ type: 0, userid: '1' }],
        users: undefined
      })
      filesLockManager.getLocksByPath.mockResolvedValue([{ key: 'lock-key', owner: { id: 1 } }] as any)

      const result = await service.callBack(mockUser, mockSpaceEnv, mockToken)

      expect(result).toEqual({ error: 0 })
      expect(filesLockManager.removeLock).toHaveBeenCalledWith('lock-key')
    })

    it('should return error when callback fails', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        status: 2,
        actions: [],
        notmodified: false,
        url: mockDocumentUrl
      })
      httpService.axiosRef.mockRejectedValue(new Error('Network error'))

      const result = await service.callBack(mockUser, mockSpaceEnv, mockToken)

      expect(result).toHaveProperty('error')
      expect(result.error).not.toBe(0)
    })

    it('should reject document downloads from unexpected hosts when external server is configured', async () => {
      ;(service as any).externalOnlyOfficeServer = 'http://localhost:3000/onlyoffice'
      jwtService.verifyAsync.mockResolvedValue({
        status: 2,
        actions: [],
        users: [],
        notmodified: false,
        url: 'http://internal-service.local/document.docx?md5=abc123&expires=1739400549&shardkey=-33120641&filename=document.docx'
      })

      const result = await service.callBack(mockUser, mockSpaceEnv, mockToken)

      expect(result).toEqual({ error: 'document download url is not allowed' })
      expect(httpService.axiosRef).not.toHaveBeenCalled()
    })

    it('should throw error when file lock creation fails', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        status: 1,
        actions: [{ type: 1, userid: '1' }],
        users: ['1']
      })
      filesLockManager.create.mockResolvedValue([false, null])

      const result = await service.callBack(mockUser, mockSpaceEnv, mockToken)

      expect(result).toHaveProperty('error')
      expect(result.error).not.toBe(0)
    })
  })
})
