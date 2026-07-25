import { HttpService } from '@nestjs/axios'
import { HttpStatus } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { lookup } from 'node:dns/promises'
import fs from 'node:fs'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { transformAndValidate } from '../../../common/functions'
import * as imageUtils from '../../../common/image'
import { ContextManager } from '../../../infrastructure/context/services/context-manager.service'
import { NotificationsManager } from '../../notifications/services/notifications-manager.service'
import { SpacesManager } from '../../spaces/services/spaces-manager.service'
import * as spacesPathUtils from '../../spaces/utils/paths'
import * as spacesPermsUtils from '../../spaces/utils/permissions'
import { DEPTH } from '../../webdav/constants/webdav'
import { ACTION } from '../../../common/constants'
import { DownloadFileDto } from '../dto/file-operations.dto'
import { FileEvent, FileTaskEvent } from '../events/file-events'
import { FileError, SourceCleanupError } from '../models/file-error'
import { LockConflict } from '../models/file-lock-error'
import { SendFile } from '../utils/send-file'
import * as unzipUtils from '../utils/unzip-file'
import * as untarUtils from '../utils/untar-file'
import * as filesUtils from '../utils/files'
import * as tarUtils from '../utils/tar-file'
import * as taskUtils from '../utils/tasks'
import * as zipUtils from '../utils/zip-file'
import { FilesLockManager } from './files-lock-manager.service'
import { FilesManager } from './files-manager.service'
import { FilesQueries } from './files-queries.service'
import { FilesTasksTransfer } from './tasks/files-tasks-transfer.service'
import { Mock } from 'vitest'
import { FILE_ERROR } from '../constants/errors'
import { VersioningService } from '../../custom-versioning/services/versioning.service'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn()
}))

// Fork: versioning hooks. Stubbed so these suites keep asserting upstream
// behavior; the hooks' own assertions live alongside each write path below.
const versioning = {
  snapshotBeforeOverwrite: vi.fn().mockResolvedValue(undefined),
  purgeForPath: vi.fn().mockResolvedValue(undefined),
  purgeForFile: vi.fn().mockResolvedValue(undefined)
}

describe(FilesManager.name, () => {
  let service: FilesManager
  let filesTasksTransfer: { copy: Mock; move: Mock; delete: Mock; createByteProgressHandler: Mock; createExtractionProgressHandler: Mock }
  let http: { axiosRef: Mock }
  const lookupMock = lookup as Mock
  let filesQueries: { moveFiles: Mock; deleteFiles: Mock }
  let spacesManager: { spaceEnv: Mock }
  let contextManager: { headerOriginUrl: Mock }
  let notificationsManager: { create: Mock }
  let filesLockManager: {
    create: Mock
    checkConflicts: Mock
    removeLock: Mock
    createOrRefresh: Mock
    getLocksByPath: Mock
    convertLockToFileLockProps: Mock
    removeChildLocks: Mock
  }

  const user = { id: 7, login: 'john', tmpPath: '/data/users/john/tmp', tasksPath: '/data/users/john/tmp/tasks' } as any
  const taskPath = (cacheKey: string, name: string): string => path.join(user.tasksPath, `${taskUtils.taskTemporaryPrefix(cacheKey)}${name}`)

  const makeSpace = (overrides: Record<string, any> = {}) =>
    ({
      id: 1,
      alias: 'personal',
      repository: 'files',
      url: 'files/personal/file.txt',
      realPath: '/data/users/john/files/file.txt',
      realBasePath: '/data/users/john/files',
      dbFile: { ownerId: 7, path: 'file.txt', inTrash: false },
      inTrashRepository: false,
      quotaIsExceeded: false,
      storageQuota: null,
      willExceedQuota: vi.fn().mockReturnValue(false),
      task: undefined,
      ...overrides
    }) as any

  const setPathExists = (values: Record<string, boolean>, fallback = false) => {
    vi.mocked(filesUtils.isPathExists).mockImplementation(async (p: string) => (p in values ? values[p] : fallback))
  }

  const prepareFileTransfer = (srcPath: string, dstPath: string, dstExists = false) => {
    setPathExists({ [srcPath]: true, [path.dirname(dstPath)]: true, [dstPath]: dstExists }, false)
    vi.mocked(filesUtils.isPathIsDir).mockResolvedValueOnce(false)
  }

  const makeTrashSpace = (overrides: Record<string, any> = {}) =>
    makeSpace({
      repository: 'trash',
      url: 'trash/personal/file.txt',
      realPath: '/data/users/john/trash/file.txt',
      realBasePath: '/data/users/john/trash',
      dbFile: { ownerId: 7, path: 'file.txt', inTrash: true },
      inTrashRepository: true,
      ...overrides
    })

  const expectNoWriteOperations = () => {
    expect(filesUtils.writeFromStream).not.toHaveBeenCalled()
    expect(filesUtils.writeFromStreamAndChecksum).not.toHaveBeenCalled()
    expect(filesUtils.makeDir).not.toHaveBeenCalled()
    expect(filesUtils.createEmptyFile).not.toHaveBeenCalled()
    expect(filesUtils.copyFileContent).not.toHaveBeenCalled()
    expect(filesUtils.copyFiles).not.toHaveBeenCalled()
    expect(filesUtils.moveFiles).not.toHaveBeenCalled()
    expect(filesUtils.removeFiles).not.toHaveBeenCalled()
    expect(filesTasksTransfer.copy).not.toHaveBeenCalled()
    expect(filesTasksTransfer.move).not.toHaveBeenCalled()
    expect(filesTasksTransfer.delete).not.toHaveBeenCalled()
    expect(filesLockManager.create).not.toHaveBeenCalled()
    expect(filesLockManager.createOrRefresh).not.toHaveBeenCalled()
    expect(filesLockManager.checkConflicts).not.toHaveBeenCalled()
  }

  beforeEach(async () => {
    http = { axiosRef: vi.fn() }
    lookupMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    filesQueries = {
      moveFiles: vi.fn().mockResolvedValue(undefined),
      deleteFiles: vi.fn().mockResolvedValue(undefined)
    }
    spacesManager = {
      spaceEnv: vi.fn().mockResolvedValue(makeSpace())
    }
    contextManager = {
      headerOriginUrl: vi.fn().mockReturnValue('https://sync-in.example')
    }
    notificationsManager = {
      create: vi.fn().mockResolvedValue(undefined)
    }
    filesTasksTransfer = {
      copy: vi
        .fn()
        .mockImplementation(
          async (
            _user: any,
            srcSpace: any,
            _dstSpace: any,
            overwrite: boolean,
            _recursive: boolean,
            _isDir: boolean,
            _signal: AbortSignal,
            deleteDestination: () => Promise<void>
          ) => {
            srcSpace.task.props = { ...srcSpace.task.props, progress: 40, size: 40, totalSize: 100 }
            if (overwrite) await deleteDestination()
          }
        ),
      move: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      createByteProgressHandler: vi.fn((space) =>
        vi.fn((bytes: number) => {
          space.task.props.size = (space.task.props.size || 0) + bytes
        })
      ),
      createExtractionProgressHandler: vi.fn().mockReturnValue(vi.fn())
    }
    filesLockManager = {
      create: vi.fn().mockResolvedValue([true, { key: 'lock-1' }]),
      checkConflicts: vi.fn().mockResolvedValue(undefined),
      removeLock: vi.fn().mockResolvedValue(true),
      createOrRefresh: vi.fn().mockResolvedValue([false, { key: 'lock-2' }]),
      getLocksByPath: vi.fn().mockResolvedValue([]),
      convertLockToFileLockProps: vi.fn().mockReturnValue({ owner: { id: 7, login: 'john' }, app: 'Sync-in', isExclusive: true }),
      removeChildLocks: vi.fn().mockResolvedValue(undefined)
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: FilesQueries, useValue: filesQueries },
        { provide: SpacesManager, useValue: spacesManager },
        { provide: ContextManager, useValue: contextManager },
        { provide: NotificationsManager, useValue: notificationsManager },
        { provide: HttpService, useValue: http },
        { provide: FilesLockManager, useValue: filesLockManager },
        { provide: FilesTasksTransfer, useValue: filesTasksTransfer },
        { provide: VersioningService, useValue: versioning },
        FilesManager
      ]
    }).compile()

    module.useLogger(['fatal'])
    service = module.get<FilesManager>(FilesManager)

    vi.spyOn(filesUtils, 'isPathExists').mockResolvedValue(true)
    vi.spyOn(filesUtils, 'isPathIsDir').mockResolvedValue(false)
    vi.spyOn(filesUtils, 'makeDir').mockResolvedValue('/tmp' as any)
    vi.spyOn(filesUtils, 'makeTempDir').mockResolvedValue('/tmp/extract')
    vi.spyOn(filesUtils, 'tempFilePath').mockReturnValue('/tmp/staged-file')
    vi.spyOn(filesUtils, 'writeFromStream').mockResolvedValue(undefined)
    vi.spyOn(filesUtils, 'writeFromStreamAndChecksum').mockResolvedValue('sha256-abc')
    vi.spyOn(filesUtils, 'moveFiles').mockResolvedValue(undefined)
    vi.spyOn(filesUtils, 'copyFiles').mockResolvedValue(undefined)
    vi.spyOn(filesUtils, 'removeFiles').mockResolvedValue(undefined)
    vi.spyOn(filesUtils, 'touchFile').mockResolvedValue(undefined)
    vi.spyOn(filesUtils, 'createEmptyFile').mockResolvedValue(undefined)
    vi.spyOn(filesUtils, 'copyFileContent').mockResolvedValue(undefined)
    vi.spyOn(filesUtils, 'fileSize').mockResolvedValue(100)
    vi.spyOn(filesUtils, 'dirSize').mockResolvedValue([123, {}] as any)
    vi.spyOn(filesUtils, 'uniqueFilePathFromDir').mockResolvedValue('/tmp/unique-path.txt')
    vi.spyOn(filesUtils, 'uniqueDatedFilePath').mockResolvedValue({ isDir: false, path: '/trash/file-2026.txt' })
    vi.spyOn(taskUtils, 'createTaskTemporaryDir').mockResolvedValue(taskPath('task-d', 'archive'))
    vi.spyOn(taskUtils, 'taskTemporaryPath').mockImplementation((parentPath, cacheKey, name) =>
      path.join(parentPath, `${taskUtils.taskTemporaryPrefix(cacheKey)}${path.basename(name)}`)
    )
    vi.spyOn(tarUtils, 'createTar').mockResolvedValue(undefined)
    vi.spyOn(zipUtils, 'createZip').mockResolvedValue(undefined)
    vi.spyOn(filesUtils, 'getMimeType').mockReturnValue('image-png')
    vi.spyOn(spacesPermsUtils, 'canAccessToSpace').mockReturnValue(true)
    vi.spyOn(spacesPermsUtils, 'haveSpaceEnvPermissions').mockReturnValue(true)
    vi.spyOn(spacesPathUtils, 'realTrashPathFromSpace').mockReturnValue('/data/users/john/trash')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('should be defined', () => {
    expect(service).toBeDefined()
  })

  it('sendFileFromSpace should return a SendFile instance', () => {
    const space = makeSpace()
    const sendFile = service.sendFileFromSpace(space, 'download.txt')
    expect(sendFile).toBeInstanceOf(SendFile)
  })

  describe('saveStream', () => {
    it('should reject POST when resource already exists', async () => {
      const space = makeSpace()
      setPathExists({ [space.realPath]: true }, true)

      await expect(service.saveStream(user, space, { method: 'POST', headers: {}, raw: Readable.from(['x']) } as any)).rejects.toEqual(
        new FileError(HttpStatus.METHOD_NOT_ALLOWED, 'Resource already exists')
      )
    })

    it('should write stream, emit event and release lock', async () => {
      const space = makeSpace()
      setPathExists({ [space.realPath]: false, [path.dirname(space.realPath)]: true }, false)
      const emitSpy = vi.spyOn(FileEvent, 'emit')

      const result = await service.saveStream(user, space, { method: 'PUT', headers: {}, raw: Readable.from(['hello']) } as any)

      expect(result).toBe(false)
      expect(filesLockManager.create).toHaveBeenCalledWith(user, space.dbFile, 'Sync-in', DEPTH.RESOURCE)
      expect(filesUtils.writeFromStream).toHaveBeenCalledWith(space.realPath, expect.anything(), 0)
      expect(filesLockManager.removeLock).toHaveBeenCalledWith('lock-1')
      expect(emitSpy).toHaveBeenCalledWith('event', { user, space, action: ACTION.ADD, rPath: space.realPath })
    })

    it('should use DAV conflict checks and checksum mode when requested', async () => {
      const space = makeSpace()
      setPathExists({ [space.realPath]: true, [path.dirname(space.realPath)]: true }, true)

      const checksum = await service.saveStream(
        user,
        space,
        { method: 'PUT', headers: { 'content-range': 'bytes 100-199/200' }, raw: Readable.from(['chunk']) } as any,
        { dav: { depth: DEPTH.RESOURCE, lockTokens: ['token'] }, checksumAlg: 'sha256' }
      )

      expect(checksum).toBe('sha256-abc')
      expect(filesLockManager.checkConflicts).toHaveBeenCalledWith(space.dbFile, DEPTH.RESOURCE, { userId: 7, lockTokens: ['token'] })
      expect(filesLockManager.create).not.toHaveBeenCalled()
      expect(filesUtils.writeFromStreamAndChecksum).toHaveBeenCalled()
    })

    it('should validate tmp stream before moving it to the destination', async () => {
      const space = makeSpace()
      const tmpPath = '/data/users/john/tmp/sync-in-file.txt'
      const validationError = new FileError(HttpStatus.BAD_REQUEST, 'Invalid sync upload')
      const validateTmpFile = vi.fn().mockRejectedValue(validationError)
      const emitSpy = vi.spyOn(FileEvent, 'emit')
      setPathExists({ [space.realPath]: false, [path.dirname(space.realPath)]: true, [tmpPath]: true }, false)

      await expect(
        service.saveStream(user, space, { method: 'PUT', headers: {}, raw: Readable.from(['chunk']) } as any, {
          tmpPath,
          checksumAlg: 'sha256',
          validateTmpFile
        })
      ).rejects.toEqual(validationError)

      expect(validateTmpFile).toHaveBeenCalledWith({ tmpPath, realPath: space.realPath, checksum: 'sha256-abc' })
      expect(filesUtils.writeFromStreamAndChecksum).toHaveBeenCalledWith(tmpPath, expect.anything(), 0, 'sha256')
      expect(filesUtils.moveFiles).not.toHaveBeenCalled()
      expect(filesUtils.removeFiles).not.toHaveBeenCalledWith(tmpPath)
      expect(emitSpy).not.toHaveBeenCalled()
    })
  })

  describe('saveMultipart', () => {
    it('should reject POST when target root already exists before reading multipart parts', async () => {
      const space = makeSpace()
      setPathExists({ [space.realPath]: true }, false)

      const req = {
        method: 'POST',
        files: vi.fn().mockImplementation(async function* () {
          yield { filename: path.basename(space.realPath), file: Readable.from(['content']) }
        })
      }

      await expect(service.saveMultipart(user, space, req as any)).rejects.toEqual(
        new FileError(HttpStatus.METHOD_NOT_ALLOWED, 'Resource already exists')
      )

      expect(req.files).not.toHaveBeenCalled()
      expectNoWriteOperations()
    })

    it.each([
      {
        name: 'missing parent',
        pathExists: (space: any) => ({ [space.realPath]: false, [path.dirname(space.realPath)]: false }),
        isDir: () => true,
        expected: new FileError(HttpStatus.BAD_REQUEST, 'Parent must exists')
      },
      {
        name: 'parent file',
        pathExists: (space: any) => ({ [space.realPath]: false, [path.dirname(space.realPath)]: true }),
        isDir: () => false,
        expected: new FileError(HttpStatus.BAD_REQUEST, 'Parent must be a directory')
      }
    ])('should reject POST when target root has $name', async ({ pathExists, isDir, expected }) => {
      const space = makeSpace()
      setPathExists(pathExists(space), false)
      vi.mocked(filesUtils.isPathIsDir).mockImplementation(async () => isDir())

      const req = {
        method: 'POST',
        files: vi.fn().mockImplementation(async function* () {
          yield { filename: path.basename(space.realPath), file: Readable.from(['content']) }
        })
      }

      await expect(service.saveMultipart(user, space, req as any)).rejects.toEqual(expected)

      expect(req.files).not.toHaveBeenCalled()
      expectNoWriteOperations()
    })

    it('should write one PATCH part and emit update event', async () => {
      const space = makeSpace({
        url: 'files/personal/report.txt',
        realPath: '/data/users/john/files/report.txt',
        dbFile: { ownerId: 7, path: 'report.txt' }
      })
      setPathExists({ [path.dirname(space.realPath)]: true, [space.realPath]: true, [user.tmpPath]: true }, false)
      vi.mocked(filesUtils.isPathIsDir).mockImplementation(async (p: string) => p === path.dirname(space.realPath))
      const emitSpy = vi.spyOn(FileEvent, 'emit')

      const req = {
        method: 'PATCH',
        files: async function* () {
          yield { filename: 'ignored-on-patch.txt', file: Readable.from(['content']) }
        }
      }

      await service.saveMultipart(user, space, req as any)

      const tmpWritePath = vi.mocked(filesUtils.writeFromStream).mock.calls[0][0] as string
      expect(filesLockManager.createOrRefresh).toHaveBeenCalled()
      expect(tmpWritePath.startsWith(`${user.tmpPath}${path.sep}`)).toBe(true)
      expect(tmpWritePath.endsWith('-report.txt')).toBe(true)
      expect(filesUtils.writeFromStream).toHaveBeenCalledWith(tmpWritePath, expect.anything())
      expect(filesUtils.moveFiles).toHaveBeenCalledWith(tmpWritePath, '/data/users/john/files/report.txt', true)
      expect(emitSpy).toHaveBeenCalledWith(
        'event',
        expect.objectContaining({ action: ACTION.UPDATE, rPath: '/data/users/john/files/report.txt', source: 'editor' })
      )
    })

    it('should reject PATCH when destination does not exist', async () => {
      const space = makeSpace({
        url: 'files/personal/report.txt',
        realPath: '/data/users/john/files/report.txt',
        dbFile: { ownerId: 7, path: 'report.txt' }
      })
      const emitSpy = vi.spyOn(FileEvent, 'emit')
      setPathExists({ [path.dirname(space.realPath)]: true, [space.realPath]: false }, false)
      vi.mocked(filesUtils.isPathIsDir).mockImplementation(async (p: string) => p === path.dirname(space.realPath))

      const req = {
        method: 'PATCH',
        files: async function* () {
          yield { filename: 'ignored-on-patch.txt', file: Readable.from(['content']) }
        }
      }

      await expect(service.saveMultipart(user, space, req as any)).rejects.toEqual(new FileError(HttpStatus.NOT_FOUND, 'Location not found'))

      expect(filesUtils.writeFromStream).not.toHaveBeenCalled()
      expect(filesUtils.moveFiles).not.toHaveBeenCalled()
      expect(filesUtils.removeFiles).not.toHaveBeenCalled()
      expect(filesLockManager.createOrRefresh).not.toHaveBeenCalled()
      expect(emitSpy).not.toHaveBeenCalled()
    })

    it('should write PUT to a temporary file before moving it to the destination', async () => {
      const space = makeSpace()
      const file = Readable.from(['content'])
      const emitSpy = vi.spyOn(FileEvent, 'emit')
      setPathExists({ [space.realPath]: true, [path.dirname(space.realPath)]: true, [user.tmpPath]: true }, false)
      vi.mocked(filesUtils.isPathIsDir).mockImplementation(async (p: string) => p === path.dirname(space.realPath))

      const req = {
        method: 'PUT',
        files: async function* () {
          yield { filename: path.basename(space.realPath), file }
        }
      }

      await service.saveMultipart(user, space, req as any)

      const tmpWritePath = vi.mocked(filesUtils.writeFromStream).mock.calls[0][0] as string
      expect(tmpWritePath.startsWith(`${user.tmpPath}${path.sep}`)).toBe(true)
      expect(filesUtils.writeFromStream).toHaveBeenCalledWith(tmpWritePath, file)
      expect(filesUtils.moveFiles).toHaveBeenCalledWith(tmpWritePath, space.realPath, true)
      expect(filesUtils.removeFiles).not.toHaveBeenCalled()
      expect(emitSpy).toHaveBeenCalledWith('event', expect.objectContaining({ action: ACTION.UPDATE, rPath: space.realPath }))
      expect(emitSpy).not.toHaveBeenCalledWith('event', expect.objectContaining({ source: 'editor' }))
    })

    it('should create missing destination directory and release created lock for POST nested upload', async () => {
      const space = makeSpace()
      const partFileName = 'folder/file.txt'
      const dstDir = path.join(path.dirname(space.realPath), 'folder')
      const dstFile = path.join(dstDir, 'file.txt')
      const file = Readable.from(['content'])
      const emitSpy = vi.spyOn(FileEvent, 'emit')
      setPathExists(
        {
          [space.realPath]: false,
          [path.dirname(space.realPath)]: true,
          [dstDir]: false,
          [dstFile]: false
        },
        false
      )
      vi.mocked(filesUtils.isPathIsDir).mockImplementation(async (p: string) => p === path.dirname(space.realPath))
      filesLockManager.createOrRefresh.mockResolvedValueOnce([true, { key: 'lock-created' }])

      const req = {
        method: 'POST',
        files: async function* () {
          yield { filename: partFileName, file }
        }
      }

      await service.saveMultipart(user, space, req as any)

      expect(filesUtils.makeDir).toHaveBeenCalledWith(dstDir, true)
      expect(filesUtils.writeFromStream).toHaveBeenCalledWith(dstFile, file)
      expect(filesLockManager.removeLock).toHaveBeenCalledWith('lock-created')
      expect(emitSpy).toHaveBeenCalledWith('event', expect.objectContaining({ action: ACTION.ADD, rPath: dstFile }))
    })

    it('should reject POST when resolved multipart destination already exists', async () => {
      const space = makeSpace()
      const partFileName = 'folder/file.txt'
      const dstDir = path.join(path.dirname(space.realPath), 'folder')
      const dstFile = path.join(dstDir, 'file.txt')
      const emitSpy = vi.spyOn(FileEvent, 'emit')
      setPathExists(
        {
          [space.realPath]: false,
          [path.dirname(space.realPath)]: true,
          [dstDir]: true,
          [dstFile]: true
        },
        false
      )
      vi.mocked(filesUtils.isPathIsDir).mockImplementation(async (p: string) => p === path.dirname(space.realPath) || p === dstDir)

      const req = {
        method: 'POST',
        files: async function* () {
          yield { filename: partFileName, file: Readable.from(['content']) }
        }
      }

      await expect(service.saveMultipart(user, space, req as any)).rejects.toEqual(
        new FileError(HttpStatus.METHOD_NOT_ALLOWED, 'Resource already exists')
      )

      expect(filesUtils.writeFromStream).not.toHaveBeenCalled()
      expect(filesUtils.moveFiles).not.toHaveBeenCalled()
      expect(filesUtils.removeFiles).not.toHaveBeenCalled()
      expect(filesLockManager.createOrRefresh).not.toHaveBeenCalled()
      expect(emitSpy).not.toHaveBeenCalled()
    })

    it('should reject multipart path traversal before checking destination path', async () => {
      const space = makeSpace()
      const parentPath = path.dirname(space.realPath)
      const forbiddenFile = path.resolve(`${parentPath}${path.sep}`, '../escape.txt')
      const emitSpy = vi.spyOn(FileEvent, 'emit')
      setPathExists({ [space.realPath]: false, [parentPath]: true }, false)
      vi.mocked(filesUtils.isPathIsDir).mockImplementation(async (p: string) => p === parentPath)

      const req = {
        method: 'POST',
        files: async function* () {
          yield { filename: '../escape.txt', file: Readable.from(['content']) }
        }
      }

      await expect(service.saveMultipart(user, space, req as any)).rejects.toEqual(new FileError(HttpStatus.FORBIDDEN, 'Location is not allowed'))

      expect(filesUtils.isPathExists).not.toHaveBeenCalledWith(forbiddenFile)
      expect(filesUtils.isPathIsDir).not.toHaveBeenCalledWith(forbiddenFile)
      expect(filesUtils.writeFromStream).not.toHaveBeenCalled()
      expect(filesUtils.moveFiles).not.toHaveBeenCalled()
      expect(filesLockManager.createOrRefresh).not.toHaveBeenCalled()
      expect(emitSpy).not.toHaveBeenCalled()
    })

    it('should keep existing destination untouched when PUT upload is too large', async () => {
      const space = makeSpace()
      const file = Readable.from(['content']) as Readable & { truncated: boolean }
      file.truncated = true
      const emitSpy = vi.spyOn(FileEvent, 'emit')
      setPathExists({ [space.realPath]: true, [path.dirname(space.realPath)]: true, [user.tmpPath]: true }, false)
      vi.mocked(filesUtils.isPathIsDir).mockImplementation(async (p: string) => p === path.dirname(space.realPath))

      const req = {
        method: 'PUT',
        files: async function* () {
          yield { filename: path.basename(space.realPath), file }
        }
      }

      await expect(service.saveMultipart(user, space, req as any)).rejects.toEqual(
        new FileError(HttpStatus.PAYLOAD_TOO_LARGE, FILE_ERROR.MAX_FILE_SIZE_EXCEEDED)
      )

      const tmpWritePath = vi.mocked(filesUtils.writeFromStream).mock.calls[0][0] as string
      expect(tmpWritePath.startsWith(`${user.tmpPath}${path.sep}`)).toBe(true)
      expect(filesUtils.writeFromStream).toHaveBeenCalledWith(tmpWritePath, file)
      expect(filesUtils.removeFiles).toHaveBeenCalledWith(tmpWritePath)
      expect(filesUtils.removeFiles).not.toHaveBeenCalledWith(space.realPath)
      expect(filesUtils.moveFiles).not.toHaveBeenCalled()
      expect(emitSpy).not.toHaveBeenCalled()
    })

    it('should reject truncated multipart file as payload too large', async () => {
      const space = makeSpace()
      const dstFile = '/data/users/john/files/too-big.bin'
      const file = Readable.from(['content']) as Readable & { truncated: boolean }
      file.truncated = true
      const emitSpy = vi.spyOn(FileEvent, 'emit')
      setPathExists({ [space.realPath]: false, [path.dirname(space.realPath)]: true, [dstFile]: false }, false)
      vi.mocked(filesUtils.isPathIsDir).mockResolvedValue(true)

      const req = {
        method: 'POST',
        files: vi.fn().mockImplementation(async function* () {
          yield { filename: 'too-big.bin', file }
        })
      }

      await expect(service.saveMultipart(user, space, req as any)).rejects.toEqual(
        new FileError(HttpStatus.PAYLOAD_TOO_LARGE, FILE_ERROR.MAX_FILE_SIZE_EXCEEDED)
      )

      expect(req.files).toHaveBeenCalled()
      expect(filesUtils.writeFromStream).toHaveBeenCalledWith(dstFile, file)
      expect(filesUtils.removeFiles).toHaveBeenCalledWith(dstFile)
      expect(emitSpy).not.toHaveBeenCalled()
    })

    it('should map multipart iterator file size errors to payload too large', async () => {
      const space = makeSpace()
      const error = Object.assign(new Error('request file too large'), { code: 'FST_REQ_FILE_TOO_LARGE', statusCode: HttpStatus.PAYLOAD_TOO_LARGE })
      setPathExists({ [space.realPath]: false, [path.dirname(space.realPath)]: true }, false)
      vi.mocked(filesUtils.isPathIsDir).mockResolvedValue(true)

      const req = {
        method: 'POST',
        files: vi.fn().mockImplementation(async function* () {
          yield* []
          throw error
        })
      }

      await expect(service.saveMultipart(user, space, req as any)).rejects.toEqual(
        new FileError(HttpStatus.PAYLOAD_TOO_LARGE, FILE_ERROR.MAX_FILE_SIZE_EXCEEDED)
      )

      expect(filesUtils.writeFromStream).not.toHaveBeenCalled()
    })

    it('should not map non-file-size multipart 413 errors to file size limit', async () => {
      const space = makeSpace()
      const error = Object.assign(new Error('reach parts limit'), { code: 'FST_PARTS_LIMIT', statusCode: HttpStatus.PAYLOAD_TOO_LARGE })
      setPathExists({ [space.realPath]: false, [path.dirname(space.realPath)]: true }, false)
      vi.mocked(filesUtils.isPathIsDir).mockResolvedValue(true)

      const req = {
        method: 'POST',
        files: vi.fn().mockImplementation(async function* () {
          yield* []
          throw error
        })
      }

      await expect(service.saveMultipart(user, space, req as any)).rejects.toBe(error)

      expect(filesUtils.writeFromStream).not.toHaveBeenCalled()
    })

    it.each([
      {
        name: 'existing destination directory',
        partFileName: 'file.txt',
        pathExists: (space: any) => ({
          [space.realPath]: true,
          [path.dirname(space.realPath)]: true,
          [user.tmpPath]: true
        }),
        isDir: (space: any, p: string) => p === space.realPath || p === path.dirname(space.realPath)
      },
      {
        name: 'destination parent file',
        partFileName: 'folder/file.txt',
        pathExists: (space: any) => ({
          [path.join(path.dirname(space.realPath), 'folder')]: true,
          [user.tmpPath]: true
        }),
        isDir: () => false
      }
    ])('should cleanup temporary file when PUT move fails after deleting $name', async ({ partFileName, pathExists, isDir }) => {
      const space = makeSpace()
      const file = Readable.from(['content'])
      const error = new Error('move failed')
      const deleteSpy = vi.spyOn(service, 'delete').mockResolvedValue(undefined)
      const emitSpy = vi.spyOn(FileEvent, 'emit')
      setPathExists(pathExists(space), false)
      vi.mocked(filesUtils.isPathIsDir).mockImplementation(async (p: string) => isDir(space, p))
      vi.mocked(filesUtils.moveFiles).mockRejectedValueOnce(error)

      const req = {
        method: 'PUT',
        files: async function* () {
          yield { filename: partFileName, file }
        }
      }

      await expect(service.saveMultipart(user, space, req as any)).rejects.toBe(error)

      const tmpWritePath = vi.mocked(filesUtils.writeFromStream).mock.calls[0][0] as string
      expect(filesUtils.writeFromStream).toHaveBeenCalledWith(tmpWritePath, file)
      expect(deleteSpy).toHaveBeenCalledTimes(1)
      expect(filesUtils.moveFiles).toHaveBeenCalledWith(tmpWritePath, expect.stringContaining(path.basename(partFileName)), true)
      expect(filesUtils.removeFiles).toHaveBeenCalledWith(tmpWritePath)
      expect(emitSpy).not.toHaveBeenCalled()
      expect(vi.mocked(filesUtils.writeFromStream).mock.invocationCallOrder[0]).toBeLessThan(deleteSpy.mock.invocationCallOrder[0])
      expect(deleteSpy.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(filesUtils.moveFiles).mock.invocationCallOrder[0])
    })

    it('should recreate destination directory after deleting a parent file before moving PUT tmp file', async () => {
      const space = makeSpace()
      const partFileName = 'folder/file.txt'
      const dstDir = path.join(path.dirname(space.realPath), 'folder')
      const dstFile = path.join(dstDir, 'file.txt')
      const file = Readable.from(['content'])
      const deleteSpy = vi.spyOn(service, 'delete').mockResolvedValue(undefined)
      let dstDirExistsChecks = 0
      vi.mocked(filesUtils.isPathExists).mockImplementation(async (p: string) => {
        if (p === dstDir) {
          dstDirExistsChecks++
          return dstDirExistsChecks === 1
        }
        return false
      })
      vi.mocked(filesUtils.isPathIsDir).mockImplementation(async () => false)

      const req = {
        method: 'PUT',
        files: async function* () {
          yield { filename: partFileName, file }
        }
      }

      await service.saveMultipart(user, space, req as any)

      const tmpWritePath = vi.mocked(filesUtils.writeFromStream).mock.calls[0][0] as string
      expect(deleteSpy).toHaveBeenCalledTimes(1)
      expect(filesUtils.makeDir).toHaveBeenCalledWith(dstDir, true)
      expect(filesUtils.moveFiles).toHaveBeenCalledWith(tmpWritePath, dstFile, true)
      expect(deleteSpy.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(filesUtils.makeDir).mock.invocationCallOrder[0])
      expect(vi.mocked(filesUtils.makeDir).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(filesUtils.moveFiles).mock.invocationCallOrder[0])
    })
  })

  describe('touch', () => {
    it('should fail when location does not exist', async () => {
      const space = makeSpace()
      vi.mocked(filesUtils.isPathExists).mockResolvedValueOnce(false)

      await expect(service.touch(user, space, 123456)).rejects.toEqual(new FileError(HttpStatus.NOT_FOUND, 'Location not found'))
    })

    it('should check locks and update mtime', async () => {
      const space = makeSpace()
      vi.mocked(filesUtils.isPathExists).mockResolvedValueOnce(true)

      await service.touch(user, space, 111)

      expect(filesLockManager.checkConflicts).toHaveBeenCalledWith(space.dbFile, DEPTH.RESOURCE, { userId: 7 })
      expect(filesUtils.touchFile).toHaveBeenCalledWith(space.realPath, 111)
    })
  })

  describe('creation', () => {
    it('mkFile should use sample document when requested', async () => {
      const space = makeSpace({ realPath: '/data/users/john/files/doc.docx' })
      vi.mocked(filesUtils.isPathExists).mockResolvedValueOnce(false)
      const emitSpy = vi.spyOn(FileEvent, 'emit')

      await service.mkFile(user, space, false, true, true)

      expect(filesUtils.copyFileContent).toHaveBeenCalledWith(
        expect.stringContaining('assets/samples/sample.docx'),
        '/data/users/john/files/doc.docx'
      )
      expect(emitSpy).toHaveBeenCalledWith('event', { user, space, action: ACTION.ADD, rPath: space.realPath })
    })

    it('mkDir should check conflicts and create directory', async () => {
      const space = makeSpace({ realPath: '/data/users/john/files/folder' })
      vi.mocked(filesUtils.isPathExists).mockResolvedValueOnce(false).mockResolvedValueOnce(true)

      await service.mkDir(user, space, false, { depth: DEPTH.INFINITY, lockTokens: ['lt1'] })

      expect(filesLockManager.checkConflicts).toHaveBeenCalledWith(space.dbFile, DEPTH.INFINITY, { userId: 7, lockTokens: ['lt1'] })
      expect(filesUtils.makeDir).toHaveBeenCalledWith('/data/users/john/files/folder', false)
    })
  })

  describe('write protection in trash repository', () => {
    it.each([
      {
        name: 'saveStream',
        run: (space: any) => service.saveStream(user, space, { method: 'PUT', headers: {}, raw: Readable.from(['x']) } as any)
      },
      {
        name: 'saveMultipart',
        run: (space: any) =>
          service.saveMultipart(user, space, {
            method: 'POST',
            files: async function* () {
              yield { filename: 'file.txt', file: Readable.from(['x']) }
            }
          } as any)
      },
      {
        name: 'touch',
        run: (space: any) => service.touch(user, space, 111)
      },
      {
        name: 'mkFile',
        run: (space: any) => service.mkFile(user, space)
      },
      {
        name: 'mkDir',
        run: (space: any) => service.mkDir(user, space)
      },
      {
        name: 'downloadFromUrl',
        run: (space: any) => service.downloadFromUrl(user, space, { url: 'https://example.org/file.txt' })
      },
      {
        name: 'compress',
        run: (space: any) =>
          service.compress(user, space, {
            name: 'archive',
            extension: 'tar',
            compression: false,
            compressInDirectory: true,
            files: [{ name: 'file.txt', path: '/data/users/john/files/file.txt' }]
          } as any)
      },
      {
        name: 'decompress',
        run: (space: any) => service.decompress(user, space)
      },
      {
        name: 'copyMove',
        run: (space: any) => {
          const src = makeSpace({
            id: 31,
            url: 'files/personal/src.txt',
            realPath: '/data/users/john/files/src.txt',
            realBasePath: '/data/users/john/files',
            dbFile: { ownerId: 7, path: 'src.txt', inTrash: false }
          })
          return service.copyMove(user, src, space, false)
        }
      }
    ])('should reject $name in trash repository', async ({ run }) => {
      const space = makeTrashSpace()
      await expect(run(space)).rejects.toEqual(new FileError(HttpStatus.FORBIDDEN, 'The trash is read-only'))
      expectNoWriteOperations()
    })
  })

  describe('copyMove', () => {
    it('should copy file and emit add event', async () => {
      const src = makeSpace({
        id: 10,
        url: 'files/personal/src.txt',
        realPath: '/data/users/john/files/src.txt',
        realBasePath: '/data/users/john/files',
        dbFile: { ownerId: 7, path: 'src.txt', inTrash: false }
      })
      const dst = makeSpace({
        id: 11,
        url: 'files/personal/dst.txt',
        realPath: '/data/users/john/files/dst.txt',
        realBasePath: '/data/users/john/files',
        dbFile: { ownerId: 7, path: 'dst.txt', inTrash: false },
        storageQuota: null
      })
      setPathExists(
        {
          [src.realPath]: true,
          [path.dirname(dst.realPath)]: true,
          [dst.realPath]: false
        },
        false
      )
      vi.mocked(filesUtils.isPathIsDir).mockResolvedValueOnce(false)
      const emitSpy = vi.spyOn(FileEvent, 'emit')

      await service.copyMove(user, src, dst, false)

      expect(filesLockManager.checkConflicts).toHaveBeenCalledWith(dst.dbFile, DEPTH.RESOURCE, { userId: 7, lockTokens: undefined })
      expect(filesUtils.copyFiles).toHaveBeenCalledWith(src.realPath, dst.realPath, false, false)
      expect(filesTasksTransfer.copy).not.toHaveBeenCalled()
      expect(emitSpy).toHaveBeenCalledWith('event', { user, space: dst, action: ACTION.ADD, rPath: dst.realPath })
    })

    it('should move across spaces and update db', async () => {
      const src = makeSpace({
        id: 21,
        url: 'files/personal/src.txt',
        realPath: '/src-base/src.txt',
        realBasePath: '/src-base',
        dbFile: { ownerId: 7, path: 'src.txt', inTrash: false }
      })
      const dst = makeSpace({
        id: 22,
        url: 'files/project/dst.txt',
        realPath: '/dst-base/dst.txt',
        realBasePath: '/dst-base',
        dbFile: { ownerId: null, spaceId: 22, path: 'dst.txt', inTrash: false },
        storageQuota: null
      })
      setPathExists(
        {
          [src.realPath]: true,
          [path.dirname(dst.realPath)]: true,
          [dst.realPath]: false
        },
        false
      )
      vi.mocked(filesUtils.isPathIsDir).mockResolvedValueOnce(false)
      const emitSpy = vi.spyOn(FileEvent, 'emit')

      await service.copyMove(user, src, dst, true)

      expect(filesUtils.moveFiles).toHaveBeenCalledWith('/src-base/src.txt', '/dst-base/dst.txt', false)
      expect(filesTasksTransfer.move).not.toHaveBeenCalled()
      expect(filesQueries.moveFiles).toHaveBeenCalledWith(src.dbFile, dst.dbFile, false)
      expect(emitSpy).toHaveBeenCalledWith('event', { user, space: src, action: ACTION.DELETE_PERMANENTLY, rPath: '/src-base/src.txt' })
      expect(emitSpy).toHaveBeenCalledWith('event', { user, space: dst, action: ACTION.ADD, rPath: '/dst-base/dst.txt' })
    })

    it('should update the database before reporting an abortable move source cleanup failure', async () => {
      const src = makeSpace({
        url: 'files/source/src.txt',
        realPath: '/src-base/src.txt',
        dbFile: { ownerId: 7, path: 'src.txt', inTrash: false },
        task: { cacheKey: 'task-move', props: {} }
      })
      const dst = makeSpace({
        url: 'files/destination/dst.txt',
        realPath: '/dst-base/dst.txt',
        dbFile: { ownerId: 7, path: 'dst.txt', inTrash: false }
      })
      const signal = new AbortController().signal
      const cleanupError = new SourceCleanupError(src.realPath, dst.realPath, { cause: new Error('cleanup failed') })
      prepareFileTransfer(src.realPath, dst.realPath)
      filesTasksTransfer.move.mockResolvedValueOnce(cleanupError)

      await expect(service.copyMove(user, src, dst, true, false, false, undefined, signal)).rejects.toBe(cleanupError)

      expect(filesTasksTransfer.move).toHaveBeenCalledWith(user, src, dst, false, false, signal, expect.any(Function))
      expect(filesUtils.moveFiles).not.toHaveBeenCalled()
      expect(filesQueries.moveFiles).toHaveBeenCalledWith(src.dbFile, dst.dbFile, false)
    })

    it('should use the regular move path for a non-cancellable move task', async () => {
      const src = makeSpace({
        realPath: '/data/users/john/files/src.txt',
        dbFile: { ownerId: 7, path: 'src.txt', inTrash: false },
        task: { cacheKey: 'task-move', props: {} }
      })
      const dst = makeSpace({
        realPath: '/data/users/john/files/dst.txt',
        dbFile: { ownerId: 7, path: 'dst.txt', inTrash: false }
      })
      prepareFileTransfer(src.realPath, dst.realPath)

      await service.copyMove(user, src, dst, true)

      expect(filesUtils.moveFiles).toHaveBeenCalledWith(src.realPath, dst.realPath, false)
      expect(filesTasksTransfer.move).not.toHaveBeenCalled()
    })

    it('should preserve the regular overwrite path outside a task context', async () => {
      const src = makeSpace({
        realPath: '/data/users/john/files/src.txt',
        dbFile: { ownerId: 7, path: 'src.txt', inTrash: false }
      })
      const dst = makeSpace({
        realPath: '/data/users/john/files/dst.txt',
        dbFile: { ownerId: 7, path: 'dst.txt', inTrash: false }
      })
      prepareFileTransfer(src.realPath, dst.realPath, true)
      const deleteSpy = vi.spyOn(service, 'delete').mockResolvedValueOnce(undefined)

      await service.copyMove(user, src, dst, false, true)

      expect(deleteSpy).toHaveBeenCalledWith(user, dst)
      expect(filesUtils.copyFiles).toHaveBeenCalledWith(src.realPath, dst.realPath, true, false)
      expect(filesTasksTransfer.copy).not.toHaveBeenCalled()
      expect(deleteSpy.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(filesUtils.copyFiles).mock.invocationCallOrder[0])
    })

    it('should stage an overwrite before deleting the existing destination', async () => {
      const src = makeSpace({
        realPath: '/data/users/john/files/src.txt',
        dbFile: { ownerId: 7, path: 'src.txt', inTrash: false },
        task: { cacheKey: 'task-copy', props: {} }
      })
      const dst = makeSpace({
        realPath: '/data/users/john/files/dst.txt',
        dbFile: { ownerId: 7, path: 'dst.txt', inTrash: false }
      })
      prepareFileTransfer(src.realPath, dst.realPath, true)
      const deleteSpy = vi.spyOn(service, 'delete').mockResolvedValueOnce(undefined)
      const signal = new AbortController().signal

      await service.copyMove(user, src, dst, false, true, false, undefined, signal)

      expect(filesTasksTransfer.copy).toHaveBeenCalledWith(user, src, dst, true, false, false, signal, expect.any(Function))
      expect(deleteSpy).toHaveBeenCalledWith(user, dst)
      expect(src.task.props).toMatchObject({ progress: 40, size: 40, totalSize: 100 })
    })
  })

  describe('delete', () => {
    it('should remove trash file, locks and db entries', async () => {
      const space = makeSpace({ inTrashRepository: true, realPath: '/data/users/john/trash/old.txt' })
      vi.mocked(filesUtils.isPathExists).mockResolvedValueOnce(true)
      vi.mocked(filesUtils.isPathIsDir).mockResolvedValueOnce(true)
      filesLockManager.getLocksByPath.mockResolvedValueOnce([{ key: 'lk-1' }])
      const emitSpy = vi.spyOn(FileEvent, 'emit')

      await service.delete(user, space)

      expect(filesUtils.removeFiles).toHaveBeenCalledWith('/data/users/john/trash/old.txt')
      expect(filesLockManager.removeChildLocks).toHaveBeenCalledWith(user, space.dbFile)
      expect(filesLockManager.removeLock).toHaveBeenCalledWith('lk-1')
      expect(filesQueries.deleteFiles).toHaveBeenCalledWith(space.dbFile, true, false)
      expect(emitSpy).toHaveBeenCalledWith('event', { user, space, action: ACTION.DELETE_PERMANENTLY, rPath: '/data/users/john/trash/old.txt' })
    })

    it('should force delete when trash path is not available', async () => {
      const space = makeSpace({ realPath: '/data/users/john/files/no-trash.txt', inTrashRepository: false })
      vi.mocked(filesUtils.isPathExists).mockResolvedValueOnce(true)
      vi.mocked(filesUtils.isPathIsDir).mockResolvedValueOnce(false)
      vi.mocked(spacesPathUtils.realTrashPathFromSpace).mockReturnValueOnce(null)

      await service.delete(user, space)

      expect(filesUtils.removeFiles).toHaveBeenCalledWith('/data/users/john/files/no-trash.txt')
      expect(filesQueries.deleteFiles).toHaveBeenCalledWith(space.dbFile, false, true)
    })

    it('should update the database before reporting an abortable delete source cleanup failure', async () => {
      const space = makeSpace({
        realPath: '/data/users/john/files/document.txt',
        dbFile: { ownerId: 7, path: 'documents/document.txt', inTrash: false },
        task: { cacheKey: 'task-delete', props: {} }
      })
      const trashFile = '/data/users/john/trash/documents/document.txt'
      const signal = new AbortController().signal
      const cleanupError = new SourceCleanupError(space.realPath, trashFile, { cause: new Error('cleanup failed') })
      prepareFileTransfer(space.realPath, trashFile)
      filesTasksTransfer.delete.mockResolvedValueOnce(cleanupError)

      await expect(service.delete(user, space, undefined, signal)).rejects.toBe(cleanupError)

      expect(filesTasksTransfer.delete).toHaveBeenCalledWith(user, space, trashFile, false, signal, expect.any(Function))
      expect(filesUtils.moveFiles).not.toHaveBeenCalled()
      expect(filesQueries.deleteFiles).toHaveBeenCalledWith(space.dbFile, false, false)
    })

    it('should keep the regular move path outside a task context', async () => {
      const space = makeSpace({
        realPath: '/data/users/john/files/document.txt',
        dbFile: { ownerId: 7, path: 'documents/document.txt', inTrash: false }
      })
      const trashFile = '/data/users/john/trash/documents/document.txt'
      prepareFileTransfer(space.realPath, trashFile)
      const emitSpy = vi.spyOn(FileEvent, 'emit')

      await service.delete(user, space)

      expect(filesUtils.moveFiles).toHaveBeenCalledWith(space.realPath, trashFile, true)
      expect(filesTasksTransfer.delete).not.toHaveBeenCalled()
      expect(emitSpy).toHaveBeenCalledWith('event', { user, space, action: ACTION.DELETE, rPath: trashFile })
    })
  })

  it('generateThumbnail returns a webp stream + length on the sharp happy path', async () => {
    const space = makeSpace({ realPath: '/data/users/john/files/image.png' })
    ;(filesUtils.isPathExists as Mock).mockResolvedValueOnce(true)
    ;(filesUtils.getMimeType as Mock).mockReturnValueOnce('image-png')
    const buf = Buffer.from('webp-bytes')
    vi.spyOn(imageUtils, 'generateThumbnail').mockResolvedValueOnce(buf)

    const result = await service.generateThumbnail(space, 256)

    expect(result.contentType).toBe('image/webp')
    expect(result.contentLength).toBe(buf.length)
    // Stream wraps the buffer — drain to verify bytes match.
    const chunks: Buffer[] = []
    for await (const c of result.stream) chunks.push(c as Buffer)
    expect(Buffer.concat(chunks).toString()).toBe('webp-bytes')
  })

  it('generateThumbnail rejects non-image mime with BAD_REQUEST', async () => {
    const space = makeSpace({ realPath: '/data/users/john/files/notes.txt' })
    ;(filesUtils.isPathExists as Mock).mockResolvedValueOnce(true)
    ;(filesUtils.getMimeType as Mock).mockReturnValueOnce('text-plain')

    await expect(service.generateThumbnail(space, 256)).rejects.toEqual(new FileError(HttpStatus.BAD_REQUEST, 'File is not an image'))
  })

  it('generateThumbnail falls back to original bytes (with file length) when sharp cannot decode', async () => {
    // Real-world trigger: JPEG XL (.jpg with `ff 0a` magic) and HEIC files
    // sharp's prebuilt libvips can't decode. Service streams the raw file
    // with the original mime instead of 404'ing — modern clients (browsers,
    // NC iOS 17+) decode these natively. We stat the file for Content-Length
    // because NC iOS' preview cache rejects responses without one.
    const space = makeSpace({ realPath: '/data/users/john/files/jxl-as-jpg.jpg' })
    ;(filesUtils.isPathExists as Mock).mockResolvedValueOnce(true)
    ;(filesUtils.getMimeType as Mock).mockReturnValueOnce('image-jpeg')
    vi.spyOn(imageUtils, 'generateThumbnail').mockRejectedValueOnce(new Error('Input file contains unsupported image format'))
    const fakeStream = new PassThrough()
    vi.spyOn(fs, 'createReadStream').mockReturnValueOnce(fakeStream as unknown as fs.ReadStream)
    vi.spyOn(fs.promises, 'stat').mockResolvedValueOnce({ size: 12345 } as fs.Stats)

    const result = await service.generateThumbnail(space, 256)

    expect(fs.createReadStream).toHaveBeenCalledWith(space.realPath)
    expect(result).toEqual({ stream: fakeStream, contentType: 'image/jpeg', contentLength: 12345 })
  })

  describe('downloadFromUrl', () => {
    describe('dto validation', () => {
      it('should accept http and https schemes', () => {
        expect(transformAndValidate(DownloadFileDto, { url: 'https://example.org/file.txt' }).url).toBe('https://example.org/file.txt')
        expect(transformAndValidate(DownloadFileDto, { url: 'http://example.org/file.txt' }).url).toBe('http://example.org/file.txt')
      })

      it('should reject non-http(s) schemes', () => {
        const invalidUrls = ['ftp://example.org/file.txt', 'file:///tmp/file.txt', 'ws://example.org/file.txt']
        for (const url of invalidUrls) {
          expect(() => transformAndValidate(DownloadFileDto, { url })).toThrow()
        }
      })
    })

    it('should throw conflict when lock cannot be created', async () => {
      const space = makeSpace()
      filesLockManager.create.mockResolvedValueOnce([false, { key: 'other', owner: { id: 99 } }])

      await expect(service.downloadFromUrl(user, space, { url: 'https://example.org/file.txt' })).rejects.toBeInstanceOf(LockConflict)
    })

    it('should handle HEAD+GET and emit task watch/event', async () => {
      const space = makeSpace({ task: { cacheKey: 'task-1', props: {} } })
      vi.mocked(filesUtils.uniqueFilePathFromDir).mockResolvedValueOnce('/tmp/download.txt')
      http.axiosRef
        .mockResolvedValueOnce({
          headers: { 'content-length': '55' },
          request: { socket: { remoteAddress: '8.8.8.8' } }
        })
        .mockResolvedValueOnce({
          data: Readable.from(['abc']),
          request: { socket: { remoteAddress: '8.8.8.8' } }
        })
      const taskEmitSpy = vi.spyOn(FileTaskEvent, 'emit')
      const fileEmitSpy = vi.spyOn(FileEvent, 'emit')

      await service.downloadFromUrl(user, space, { url: 'https://example.org/file.txt' })

      expect(space.task.props).toMatchObject({ progress: 1, size: 0, totalSize: 55 })
      expect(taskEmitSpy).toHaveBeenCalledWith('startWatch', space, '/tmp/download.txt')
      expect(taskUtils.taskTemporaryPath).toHaveBeenCalledWith(user.tasksPath, 'task-1', '/tmp/download.txt')
      expect(filesUtils.tempFilePath).not.toHaveBeenCalled()
      expect(filesUtils.writeFromStream).toHaveBeenCalledWith(
        taskPath('task-1', 'download.txt'),
        expect.anything(),
        0,
        55,
        undefined,
        expect.any(Function)
      )
      expect(filesTasksTransfer.createByteProgressHandler).toHaveBeenCalledWith(space)
      expect(filesUtils.moveFiles).toHaveBeenCalledWith(taskPath('task-1', 'download.txt'), '/tmp/download.txt')
      expect(filesLockManager.create).toHaveBeenCalledWith(
        user,
        expect.objectContaining({ path: 'download.txt' }),
        expect.any(String),
        DEPTH.RESOURCE
      )
      expect(filesLockManager.removeLock).toHaveBeenCalledWith('lock-1')
      expect(fileEmitSpy).toHaveBeenCalledWith('event', { user, space, action: ACTION.ADD, rPath: '/tmp/download.txt' })
    })

    it('should cleanup partial file and skip ADD event when download write fails', async () => {
      const error = new FileError(HttpStatus.PAYLOAD_TOO_LARGE, FILE_ERROR.MAX_FILE_SIZE_EXCEEDED)
      const space = makeSpace()
      vi.mocked(filesUtils.uniqueFilePathFromDir).mockResolvedValueOnce('/tmp/download.txt')
      vi.mocked(filesUtils.tempFilePath).mockReturnValueOnce('/data/users/john/tmp/download.txt-download-uuid')
      vi.mocked(filesUtils.writeFromStream).mockRejectedValueOnce(error)
      http.axiosRef
        .mockResolvedValueOnce({
          headers: { 'content-length': '55' },
          request: { socket: { remoteAddress: '8.8.8.8' } }
        })
        .mockResolvedValueOnce({
          data: Readable.from(['abc']),
          request: { socket: { remoteAddress: '8.8.8.8' } }
        })
      const fileEmitSpy = vi.spyOn(FileEvent, 'emit')

      await expect(service.downloadFromUrl(user, space, { url: 'https://example.org/file.txt' })).rejects.toBe(error)

      expect(filesUtils.removeFiles).toHaveBeenCalledWith('/data/users/john/tmp/download.txt-download-uuid')
      expect(filesUtils.moveFiles).not.toHaveBeenCalled()
      expect(filesLockManager.removeLock).toHaveBeenCalledWith('lock-1')
      expect(fileEmitSpy).not.toHaveBeenCalledWith('event', { user, space, action: ACTION.ADD, rPath: '/tmp/download.txt' })
    })

    it('should cleanup temporary file and skip ADD event when publishing download fails', async () => {
      const error = new Error('move failed')
      const space = makeSpace()
      vi.mocked(filesUtils.uniqueFilePathFromDir).mockResolvedValueOnce('/tmp/download.txt')
      vi.mocked(filesUtils.tempFilePath).mockReturnValueOnce('/data/users/john/tmp/download.txt-download-uuid')
      vi.mocked(filesUtils.moveFiles).mockRejectedValueOnce(error)
      http.axiosRef
        .mockResolvedValueOnce({
          headers: { 'content-length': '55' },
          request: { socket: { remoteAddress: '8.8.8.8' } }
        })
        .mockResolvedValueOnce({
          data: Readable.from(['abc']),
          request: { socket: { remoteAddress: '8.8.8.8' } }
        })
      const fileEmitSpy = vi.spyOn(FileEvent, 'emit')

      await expect(service.downloadFromUrl(user, space, { url: 'https://example.org/file.txt' })).rejects.toBe(error)

      expect(filesUtils.removeFiles).toHaveBeenCalledWith('/data/users/john/tmp/download.txt-download-uuid')
      expect(filesLockManager.removeLock).toHaveBeenCalledWith('lock-1')
      expect(fileEmitSpy).not.toHaveBeenCalledWith('event', { user, space, action: ACTION.ADD, rPath: '/tmp/download.txt' })
    })
  })

  describe('compress', () => {
    it('should archive files and emit events', async () => {
      const tarSpy = vi.mocked(tarUtils.createTar).mockImplementationOnce(async (_outputPath, _entries, _gzip, _signal, onProgress) => {
        onProgress?.(Buffer.byteLength('content'))
      })
      vi.mocked(filesUtils.uniqueFilePathFromDir).mockResolvedValueOnce('/tmp/archive.tgz')
      vi.mocked(filesUtils.isPathIsDir).mockImplementation(async (p: string) => p.endsWith('/dir'))
      const space = makeSpace({ realPath: '/data/users/john/files/source.txt', task: { cacheKey: 'task-c', props: {} } })
      const dto = {
        name: 'archive',
        extension: 'tar',
        compression: true,
        compressInDirectory: false,
        files: [
          { path: '/data/users/john/files/dir', name: 'dir', rootAlias: null },
          { path: '/data/users/john/files/file.txt', name: 'file.txt', rootAlias: null }
        ]
      } as any
      const taskEmitSpy = vi.spyOn(FileTaskEvent, 'emit')

      await service.compress(user, space, dto)

      expect(tarSpy).toHaveBeenCalledWith(taskPath('task-c', 'archive.tgz'), dto.files, true, undefined, expect.any(Function), undefined)
      expect(taskEmitSpy).toHaveBeenCalledWith('startWatch', space, '/tmp/archive.tgz')
      expect(taskUtils.taskTemporaryPath).toHaveBeenCalledWith(user.tasksPath, 'task-c', '/tmp/archive.tgz')
      expect(filesUtils.tempFilePath).not.toHaveBeenCalled()
      expect(space.task.props.size).toBe(Buffer.byteLength('content'))
      expect(filesUtils.moveFiles).toHaveBeenCalledWith(taskPath('task-c', 'archive.tgz'), '/tmp/archive.tgz')
    })

    it('should allow archive export from trash when compressInDirectory is false', async () => {
      vi.mocked(filesUtils.uniqueFilePathFromDir).mockResolvedValueOnce('/tmp/archive-trash.tgz')
      vi.mocked(filesUtils.tempFilePath).mockReturnValueOnce('/data/users/john/tmp/archive-trash.tgz-compress-uuid')
      const emitSpy = vi.spyOn(FileEvent, 'emit')
      const space = makeTrashSpace({
        url: 'trash/personal/source.txt',
        realPath: '/data/users/john/trash/source.txt',
        dbFile: { ownerId: 7, path: 'source.txt', inTrash: true }
      })
      const dto = {
        name: 'archive-trash',
        extension: 'tar',
        compression: true,
        compressInDirectory: false,
        files: [{ path: '/data/users/john/trash/source.txt', name: 'source.txt', rootAlias: null }]
      } as any

      await expect(service.compress(user, space, dto)).resolves.toBeUndefined()
      expect(filesLockManager.create).not.toHaveBeenCalled()
      expect(tarUtils.createTar).toHaveBeenCalledWith(
        '/data/users/john/tmp/archive-trash.tgz-compress-uuid',
        dto.files,
        true,
        undefined,
        undefined,
        undefined
      )
      expect(filesUtils.moveFiles).toHaveBeenCalledWith('/data/users/john/tmp/archive-trash.tgz-compress-uuid', '/tmp/archive-trash.tgz')
      expect(emitSpy).toHaveBeenCalledWith('event', { user, space, action: ACTION.ADD, rPath: '/tmp/archive-trash.tgz' })
    })

    it('should cleanup temporary archive and skip ADD event when publishing archive fails', async () => {
      const error = new Error('move failed')
      vi.mocked(filesUtils.uniqueFilePathFromDir).mockResolvedValueOnce('/tmp/archive.tgz')
      vi.mocked(filesUtils.tempFilePath).mockReturnValueOnce('/data/users/john/tmp/archive.tgz-compress-uuid')
      vi.mocked(filesUtils.moveFiles).mockRejectedValueOnce(error)
      const emitSpy = vi.spyOn(FileEvent, 'emit')
      const space = makeSpace({ realPath: '/data/users/john/files/source.txt' })
      const dto = {
        name: 'archive',
        extension: 'tar',
        compression: true,
        compressInDirectory: false,
        files: [{ path: '/data/users/john/files/source.txt', name: 'source.txt', rootAlias: null }]
      } as any

      await expect(service.compress(user, space, dto)).rejects.toBe(error)

      expect(filesUtils.removeFiles).toHaveBeenCalledWith('/data/users/john/tmp/archive.tgz-compress-uuid')
      expect(emitSpy).not.toHaveBeenCalledWith('event', { user, space, action: ACTION.ADD, rPath: '/tmp/archive.tgz' })
    })

    it('should cleanup temporary archive when TAR creation fails', async () => {
      const error = new Error('archive failed')
      vi.mocked(filesUtils.uniqueFilePathFromDir).mockResolvedValueOnce('/tmp/archive.tgz')
      vi.mocked(filesUtils.tempFilePath).mockReturnValueOnce('/data/users/john/tmp/archive.tgz-compress-uuid')
      vi.mocked(tarUtils.createTar).mockRejectedValueOnce(error)
      const emitSpy = vi.spyOn(FileEvent, 'emit')
      const space = makeSpace({ realPath: '/data/users/john/files/source.txt' })
      const dto = {
        name: 'archive',
        extension: 'tar',
        compression: true,
        compressInDirectory: false,
        files: [{ path: '/data/users/john/files/source.txt', name: 'source.txt', rootAlias: null }]
      } as any

      await expect(service.compress(user, space, dto)).rejects.toBe(error)

      expect(filesUtils.removeFiles).toHaveBeenCalledWith('/data/users/john/tmp/archive.tgz-compress-uuid')
      expect(filesUtils.moveFiles).not.toHaveBeenCalled()
      expect(emitSpy).not.toHaveBeenCalledWith('event', { user, space, action: ACTION.ADD, rPath: '/tmp/archive.tgz' })
    })

    it('should preserve task cancellation while cleaning the temporary archive', async () => {
      const controller = new AbortController()
      const reason = new Error('Cancelled')
      vi.mocked(filesUtils.uniqueFilePathFromDir).mockResolvedValueOnce('/tmp/archive.tar')
      vi.mocked(filesUtils.tempFilePath).mockReturnValueOnce('/data/users/john/tmp/archive.tar-compress-uuid')
      vi.mocked(tarUtils.createTar).mockRejectedValueOnce(reason)
      const space = makeSpace({ realPath: '/data/users/john/files/source.txt' })
      const dto = {
        name: 'archive',
        extension: 'tar',
        compression: false,
        compressInDirectory: false,
        files: [{ path: '/data/users/john/files/source.txt', name: 'source.txt', rootAlias: null }]
      } as any

      controller.abort(reason)
      await expect(service.compress(user, space, dto, controller.signal)).rejects.toBe(reason)
      expect(tarUtils.createTar).toHaveBeenCalledWith(
        '/data/users/john/tmp/archive.tar-compress-uuid',
        dto.files,
        false,
        controller.signal,
        undefined,
        undefined
      )
      expect(filesUtils.removeFiles).toHaveBeenCalledWith('/data/users/john/tmp/archive.tar-compress-uuid')
    })

    it('should limit an archive to the known remaining quota', async () => {
      vi.mocked(filesUtils.uniqueFilePathFromDir).mockResolvedValueOnce('/data/users/john/files/archive.tar')
      vi.mocked(filesUtils.tempFilePath).mockReturnValueOnce('/data/users/john/tmp/archive.tar-compress-uuid')
      const space = makeSpace({
        realPath: '/data/users/john/files/source.txt',
        storageQuota: 100,
        storageUsage: 40
      })
      const dto = {
        name: 'archive',
        extension: 'tar',
        compression: false,
        compressInDirectory: true,
        files: [{ path: '/data/users/john/files/source.txt', name: 'source.txt', rootAlias: null }]
      } as any

      await service.compress(user, space, dto)

      expect(tarUtils.createTar).toHaveBeenCalledWith('/data/users/john/tmp/archive.tar-compress-uuid', dto.files, false, undefined, undefined, 60)
    })

    it('should create a compressed ZIP archive', async () => {
      vi.mocked(filesUtils.uniqueFilePathFromDir).mockResolvedValueOnce('/tmp/archive.zip')
      vi.mocked(filesUtils.tempFilePath).mockReturnValueOnce('/data/users/john/tmp/archive.zip-compress-uuid')
      const space = makeSpace({ realPath: '/data/users/john/files/source.txt' })
      const dto = {
        name: 'archive.zip',
        extension: 'zip',
        compression: true,
        compressInDirectory: false,
        files: [{ path: '/data/users/john/files/source.txt', name: 'source.txt', rootAlias: null }]
      } as any

      await service.compress(user, space, dto)

      expect(zipUtils.createZip).toHaveBeenCalledWith(
        '/data/users/john/tmp/archive.zip-compress-uuid',
        dto.files,
        true,
        undefined,
        undefined,
        undefined
      )
      expect(tarUtils.createTar).not.toHaveBeenCalled()
      expect(filesUtils.moveFiles).toHaveBeenCalledWith('/data/users/john/tmp/archive.zip-compress-uuid', '/tmp/archive.zip')
    })
  })

  describe('decompress', () => {
    it('should extract zip and release lock', async () => {
      const space = makeSpace({ realPath: '/data/users/john/files/archive.zip', task: { cacheKey: 'task-d', props: {} } })
      vi.mocked(filesUtils.isPathExists).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
      vi.mocked(filesUtils.uniqueFilePathFromDir).mockResolvedValueOnce('/data/users/john/files/archive')
      const unzipSpy = vi.spyOn(unzipUtils, 'extractZip').mockResolvedValueOnce(undefined)
      const taskEmitSpy = vi.spyOn(FileTaskEvent, 'emit')

      await service.decompress(user, space)

      expect(taskUtils.createTaskTemporaryDir).toHaveBeenCalledWith(user.tasksPath, 'task-d', '/data/users/john/files/archive')
      expect(filesUtils.makeTempDir).not.toHaveBeenCalled()
      expect(filesTasksTransfer.createExtractionProgressHandler).toHaveBeenCalledWith(space)
      expect(unzipSpy).toHaveBeenCalledWith(
        '/data/users/john/files/archive.zip',
        taskPath('task-d', 'archive'),
        undefined,
        undefined,
        expect.any(Function)
      )
      expect(filesUtils.moveFiles).toHaveBeenCalledWith(taskPath('task-d', 'archive'), '/data/users/john/files/archive')
      expect(taskEmitSpy).toHaveBeenCalledWith('startWatch', space, '/data/users/john/files/archive')
      expect(filesLockManager.removeLock).toHaveBeenCalledWith('lock-1')
    })

    it('should extract tar formats via extractTar', async () => {
      const space = makeSpace({ realPath: '/data/users/john/files/archive.tar.gz' })
      vi.mocked(filesUtils.isPathExists).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
      vi.mocked(filesUtils.uniqueFilePathFromDir).mockResolvedValueOnce('/data/users/john/files/archive')
      vi.mocked(filesUtils.makeTempDir).mockResolvedValueOnce('/data/users/john/tmp/archive-extract-123')
      const untarSpy = vi.spyOn(untarUtils, 'extractTar').mockResolvedValueOnce(undefined)

      await service.decompress(user, space)

      expect(untarSpy).toHaveBeenCalledWith(
        '/data/users/john/files/archive.tar.gz',
        '/data/users/john/tmp/archive-extract-123',
        true,
        undefined,
        undefined,
        undefined
      )
      expect(filesUtils.moveFiles).toHaveBeenCalledWith('/data/users/john/tmp/archive-extract-123', '/data/users/john/files/archive')
    })

    it('should limit extracted size to the known remaining quota', async () => {
      const space = makeSpace({ realPath: '/data/users/john/files/archive.zip', storageQuota: 100, storageUsage: 40 })
      vi.mocked(filesUtils.isPathExists).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
      vi.mocked(filesUtils.uniqueFilePathFromDir).mockResolvedValueOnce('/data/users/john/files/archive')
      vi.mocked(filesUtils.makeTempDir).mockResolvedValueOnce('/data/users/john/tmp/archive-extract-123')
      const unzipSpy = vi.spyOn(unzipUtils, 'extractZip').mockResolvedValueOnce(undefined)

      await service.decompress(user, space)

      expect(unzipSpy).toHaveBeenCalledWith(
        '/data/users/john/files/archive.zip',
        '/data/users/john/tmp/archive-extract-123',
        60,
        undefined,
        undefined
      )
    })

    it('should remove partial extraction and skip add event on failure', async () => {
      const space = makeSpace({ realPath: '/data/users/john/files/archive.zip' })
      vi.mocked(filesUtils.isPathExists).mockResolvedValueOnce(true)
      vi.mocked(filesUtils.uniqueFilePathFromDir).mockResolvedValueOnce('/data/users/john/files/archive')
      vi.mocked(filesUtils.makeTempDir).mockResolvedValueOnce('/data/users/john/tmp/archive-extract-123')
      const error = new Error('extraction failed')
      vi.spyOn(unzipUtils, 'extractZip').mockRejectedValueOnce(error)
      const emitSpy = vi.spyOn(FileEvent, 'emit')

      await expect(service.decompress(user, space)).rejects.toBe(error)

      expect(filesUtils.removeFiles).toHaveBeenCalledWith('/data/users/john/tmp/archive-extract-123')
      expect(filesUtils.removeFiles).not.toHaveBeenCalledWith('/data/users/john/files/archive')
      expect(filesLockManager.removeLock).toHaveBeenCalledWith('lock-1')
      expect(emitSpy).not.toHaveBeenCalledWith('event', {
        user,
        space,
        action: ACTION.ADD,
        rPath: '/data/users/john/files/archive'
      })
    })

    it('should remove temporary extraction when move fails', async () => {
      const space = makeSpace({ realPath: '/data/users/john/files/archive.zip' })
      vi.mocked(filesUtils.isPathExists).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
      vi.mocked(filesUtils.uniqueFilePathFromDir).mockResolvedValueOnce('/data/users/john/files/archive')
      vi.mocked(filesUtils.makeTempDir).mockResolvedValueOnce('/data/users/john/tmp/archive-extract-123')
      const error = new Error('move failed')
      vi.spyOn(unzipUtils, 'extractZip').mockResolvedValueOnce(undefined)
      vi.mocked(filesUtils.moveFiles).mockRejectedValueOnce(error)

      await expect(service.decompress(user, space)).rejects.toBe(error)

      expect(filesUtils.removeFiles).toHaveBeenCalledWith('/data/users/john/tmp/archive-extract-123')
      expect(filesUtils.removeFiles).not.toHaveBeenCalledWith('/data/users/john/files/archive')
      expect(filesLockManager.removeLock).toHaveBeenCalledWith('lock-1')
    })

    it('should keep an existing destination when publishing extraction', async () => {
      const space = makeSpace({ realPath: '/data/users/john/files/archive.zip' })
      vi.mocked(filesUtils.isPathExists).mockResolvedValueOnce(true).mockResolvedValueOnce(true)
      vi.mocked(filesUtils.uniqueFilePathFromDir).mockResolvedValueOnce('/data/users/john/files/archive')
      vi.mocked(filesUtils.makeTempDir).mockResolvedValueOnce('/data/users/john/tmp/archive-extract-123')
      vi.spyOn(unzipUtils, 'extractZip').mockResolvedValueOnce(undefined)

      await expect(service.decompress(user, space)).rejects.toEqual(new FileError(HttpStatus.CONFLICT, 'The destination already exists'))

      expect(filesUtils.removeFiles).toHaveBeenCalledWith('/data/users/john/tmp/archive-extract-123')
      expect(filesUtils.removeFiles).not.toHaveBeenCalledWith('/data/users/john/files/archive')
      expect(filesUtils.moveFiles).not.toHaveBeenCalled()
    })
  })

  describe('locking', () => {
    it('lock should fail if resource does not exist', async () => {
      const space = makeSpace()
      vi.mocked(filesUtils.isPathExists).mockResolvedValueOnce(false)

      await expect(service.lock(user, space)).rejects.toEqual(new FileError(HttpStatus.BAD_REQUEST, 'Lock refresh must specify an existing resource'))
    })

    it('unlock should remove owned lock and reject foreign lock', async () => {
      const space = makeSpace()
      vi.mocked(filesUtils.isPathExists).mockResolvedValue(true)
      filesLockManager.getLocksByPath.mockResolvedValueOnce([{ key: 'l1', owner: { id: 7 } }])

      await service.unlock(user, space)
      expect(filesLockManager.removeLock).toHaveBeenCalledWith('l1')

      filesLockManager.getLocksByPath.mockResolvedValueOnce([{ key: 'l2', owner: { id: 99, login: 'alice' } }])
      await expect(service.unlock(user, space)).rejects.toEqual(
        new LockConflict({ key: 'l2', owner: { id: 99, login: 'alice' } } as any, 'Conflicting lock')
      )
    })

    it('unlockRequest should throw when lock list is empty and notify foreign owner otherwise', async () => {
      const space = makeSpace()
      filesLockManager.getLocksByPath.mockResolvedValueOnce([])
      await expect(service.unlockRequest(user, space)).rejects.toEqual(new FileError(HttpStatus.NOT_FOUND, 'Lock not found'))

      filesLockManager.getLocksByPath.mockResolvedValueOnce([{ key: 'l3', owner: { id: 42 } }])
      await service.unlockRequest(user, space)
      expect(notificationsManager.create).toHaveBeenCalledWith(
        [42],
        expect.objectContaining({ element: 'file.txt', url: 'files/personal' }),
        expect.objectContaining({ author: user, currentUrl: 'https://sync-in.example' })
      )
    })
  })

  describe('getSize', () => {
    it('should return directory size or file size depending on target type', async () => {
      const space = makeSpace()
      vi.mocked(filesUtils.isPathExists).mockResolvedValue(true)
      vi.mocked(filesUtils.isPathIsDir).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
      vi.mocked(filesUtils.dirSize).mockResolvedValueOnce([500, {}])
      vi.mocked(filesUtils.fileSize).mockResolvedValueOnce(20)

      await expect(service.getSize(space)).resolves.toBe(500)
      await expect(service.getSize(space)).resolves.toBe(20)
    })
  })

  /* Fork: versioning write-path hooks.
     Seven destructive entry points must each snapshot exactly once, and
     nothing else may. These assertions are the executable form of the
     completeness invariant — a new overwrite path added upstream without a
     hook should show up as a gap here. */
  describe('versioning hooks', () => {
    const snapshots = () => versioning.snapshotBeforeOverwrite.mock.calls.map((c: any[]) => c[2].origin)

    describe('saveStream', () => {
      it('snapshots once before a direct overwrite, tagged webdav for a DAV write', async () => {
        const space = makeSpace()
        setPathExists({ [space.realPath]: true, [path.dirname(space.realPath)]: true }, true)

        await service.saveStream(user, space, { method: 'PUT', headers: {}, raw: Readable.from(['new']) } as any, {
          dav: { depth: DEPTH.RESOURCE, lockTokens: [] }
        })

        expect(snapshots()).toEqual(['webdav'])
        // Ordering is the whole point: the snapshot must precede the write
        // that destroys the bytes.
        expect(versioning.snapshotBeforeOverwrite.mock.invocationCallOrder[0]).toBeLessThan(
          vi.mocked(filesUtils.writeFromStream).mock.invocationCallOrder[0]
        )
      })

      it('does not snapshot when the file is being created', async () => {
        const space = makeSpace()
        setPathExists({ [space.realPath]: false, [path.dirname(space.realPath)]: true }, false)

        await service.saveStream(user, space, { method: 'PUT', headers: {}, raw: Readable.from(['new']) } as any)

        expect(snapshots()).toEqual([])
      })

      it('does not snapshot a resumed content-range chunk', async () => {
        // startRange > 0 means the live file ALREADY holds partial new content;
        // a snapshot here would store a half-written file.
        const space = makeSpace()
        setPathExists({ [space.realPath]: true, [path.dirname(space.realPath)]: true }, true)

        await service.saveStream(
          user,
          space,
          { method: 'PUT', headers: { 'content-range': 'bytes 100-199/200' }, raw: Readable.from(['chunk']) } as any,
          { dav: { depth: DEPTH.RESOURCE, lockTokens: [] } }
        )

        expect(snapshots()).toEqual([])
      })

      it('snapshots at the move for a tmpPath (sync) upload, not at the tmp write', async () => {
        const space = makeSpace()
        const tmpPath = '/data/users/john/tmp/sync-in-file.txt'
        setPathExists({ [space.realPath]: true, [path.dirname(space.realPath)]: true, [tmpPath]: true }, true)

        await service.saveStream(user, space, { method: 'PUT', headers: {}, raw: Readable.from(['chunk']) } as any, { tmpPath })

        expect(snapshots()).toEqual(['sync'])
        expect(versioning.snapshotBeforeOverwrite.mock.invocationCallOrder[0]).toBeLessThan(
          vi.mocked(filesUtils.moveFiles).mock.invocationCallOrder[0]
        )
      })

      it('does not snapshot a tmpPath upload when the destination does not exist yet', async () => {
        const space = makeSpace()
        const tmpPath = '/data/users/john/tmp/sync-in-file.txt'
        setPathExists({ [space.realPath]: false, [path.dirname(space.realPath)]: true, [tmpPath]: true }, false)

        await service.saveStream(user, space, { method: 'PUT', headers: {}, raw: Readable.from(['chunk']) } as any, { tmpPath })

        expect(snapshots()).toEqual([])
      })

      it('honours an explicit versionOrigin (the NC text editor)', async () => {
        const space = makeSpace()
        setPathExists({ [space.realPath]: true, [path.dirname(space.realPath)]: true }, true)

        await service.saveStream(user, space, { method: 'PUT', headers: {}, raw: Readable.from(['x']) } as any, {
          versionOrigin: 'nc-text'
        })

        expect(snapshots()).toEqual(['nc-text'])
      })
    })

    describe('saveMultipart', () => {
      const multipartReq = (method: string, filename: string) => ({
        method,
        files: async function* () {
          yield { filename, file: Readable.from(['content']) }
        }
      })

      it('snapshots a PUT overwrite as web', async () => {
        const space = makeSpace()
        setPathExists({ [space.realPath]: true, [path.dirname(space.realPath)]: true, [user.tmpPath]: true }, false)
        vi.mocked(filesUtils.isPathIsDir).mockImplementation(async (p: string) => p === path.dirname(space.realPath))

        await service.saveMultipart(user, space, multipartReq('PUT', path.basename(space.realPath)) as any)

        expect(snapshots()).toEqual(['web'])
      })

      it('snapshots a PATCH save as web-patch — the web text-editor path', async () => {
        // Gating on `overwrite` alone would miss this: overwrite is PUT-only,
        // but PATCH also reaches the same moveFiles.
        const space = makeSpace({ realPath: '/data/users/john/files/report.txt', dbFile: { ownerId: 7, path: 'report.txt' } })
        setPathExists({ [space.realPath]: true, [path.dirname(space.realPath)]: true, [user.tmpPath]: true }, false)
        vi.mocked(filesUtils.isPathIsDir).mockImplementation(async (p: string) => p === path.dirname(space.realPath))

        await service.saveMultipart(user, space, multipartReq('PATCH', 'ignored-on-patch.txt') as any)

        expect(snapshots()).toEqual(['web-patch'])
      })

      it('targets the part path, not space.realPath', async () => {
        const space = makeSpace()
        const dstFile = path.join(path.dirname(space.realPath), 'other.txt')
        setPathExists({ [dstFile]: true, [path.dirname(space.realPath)]: true, [user.tmpPath]: true }, false)
        vi.mocked(filesUtils.isPathIsDir).mockImplementation(async (p: string) => p === path.dirname(space.realPath))

        await service.saveMultipart(user, space, multipartReq('PUT', 'other.txt') as any)

        const [, partSpace] = versioning.snapshotBeforeOverwrite.mock.calls[0]
        expect(partSpace.realPath).toBe(dstFile)
        expect(partSpace.dbFile.path).toBe('other.txt')
      })

      it('does not snapshot a POST create', async () => {
        const space = makeSpace()
        setPathExists({ [space.realPath]: false, [path.dirname(space.realPath)]: true }, false)
        vi.mocked(filesUtils.isPathIsDir).mockImplementation(async (p: string) => p === path.dirname(space.realPath))

        await service.saveMultipart(user, space, multipartReq('POST', 'brand-new.txt') as any)

        expect(snapshots()).toEqual([])
      })

      it('does not snapshot when a directory is being replaced by a file', async () => {
        const space = makeSpace()
        setPathExists({ [space.realPath]: true, [path.dirname(space.realPath)]: true, [user.tmpPath]: true }, false)
        // Destination itself is a directory: there is no previous file content.
        vi.mocked(filesUtils.isPathIsDir).mockResolvedValue(true)
        vi.mocked(spacesManager.spaceEnv).mockResolvedValue(makeSpace() as any)

        await service.saveMultipart(user, space, multipartReq('PUT', path.basename(space.realPath)) as any)

        expect(snapshots()).toEqual([])
      })
    })

    describe('mkFile', () => {
      it('snapshots before truncating an existing file to zero bytes', async () => {
        // createEmptyFile is fs.writeFile(rPath, '') — "make a file" destroys
        // content when overwrite is set.
        const space = makeSpace()
        setPathExists({ [space.realPath]: true }, true)

        await service.mkFile(user, space, true)

        expect(snapshots()).toEqual(['sync-make'])
        expect(versioning.snapshotBeforeOverwrite.mock.invocationCallOrder[0]).toBeLessThan(
          vi.mocked(filesUtils.createEmptyFile).mock.invocationCallOrder[0]
        )
      })

      it('snapshots before overwriting with a sample document', async () => {
        const space = makeSpace({ realPath: '/data/users/john/files/doc.docx' })
        setPathExists({ [space.realPath]: true }, true)

        await service.mkFile(user, space, true, true, true)

        expect(snapshots()).toEqual(['sync-make'])
      })

      it('does not snapshot a plain create', async () => {
        const space = makeSpace()
        setPathExists({ [space.realPath]: false }, false)

        await service.mkFile(user, space, false)

        expect(snapshots()).toEqual([])
      })
    })

    describe('purge on delete', () => {
      it('purges when emptying the trash (the common permanent-delete path)', async () => {
        const space = makeSpace({ inTrashRepository: true, realPath: '/data/users/john/trash/old.txt' })
        vi.mocked(filesUtils.isPathExists).mockResolvedValueOnce(true)
        vi.mocked(filesUtils.isPathIsDir).mockResolvedValueOnce(false)

        await service.delete(user, space)

        expect(versioning.purgeForPath).toHaveBeenCalledWith(space.dbFile, false)
        // Must precede deleteFiles: FK ordering, and afterwards descendant ids
        // are unresolvable.
        expect(versioning.purgeForPath.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(filesQueries.deleteFiles).mock.invocationCallOrder[0])
      })

      it('passes isDir so descendants are resolved and purged too', async () => {
        const space = makeSpace({ inTrashRepository: true, realPath: '/data/users/john/trash/folder' })
        vi.mocked(filesUtils.isPathExists).mockResolvedValueOnce(true)
        vi.mocked(filesUtils.isPathIsDir).mockResolvedValueOnce(true)

        await service.delete(user, space)

        expect(versioning.purgeForPath).toHaveBeenCalledWith(space.dbFile, true)
      })

      it('purges on the force-delete fallback when no trash path resolves', async () => {
        const space = makeSpace({ realPath: '/data/users/john/files/no-trash.txt', inTrashRepository: false })
        vi.mocked(filesUtils.isPathExists).mockResolvedValueOnce(true)
        vi.mocked(filesUtils.isPathIsDir).mockResolvedValueOnce(false)
        vi.mocked(spacesPathUtils.realTrashPathFromSpace).mockReturnValueOnce(null)

        await service.delete(user, space)

        expect(versioning.purgeForPath).toHaveBeenCalledWith(space.dbFile, false)
      })

      it('does NOT purge when a file is merely moved to the trash', async () => {
        // Trashing keeps the files row (inTrash = true) with a stable id, so
        // history must survive and be there again after a restore.
        const space = makeSpace({ realPath: '/data/users/john/files/doc.txt', inTrashRepository: false })
        vi.mocked(filesUtils.isPathExists).mockResolvedValue(true)
        vi.mocked(filesUtils.isPathIsDir).mockResolvedValueOnce(false)

        await service.delete(user, space)

        expect(versioning.purgeForPath).not.toHaveBeenCalled()
      })
    })

    it('does not snapshot on copyMove overwrite — trash already covers it', async () => {
      const srcSpace = makeSpace({ realPath: '/data/users/john/files/src.txt', dbFile: { ownerId: 7, path: 'src.txt', inTrash: false } })
      const dstSpace = makeSpace({ realPath: '/data/users/john/files/dst.txt', dbFile: { ownerId: 7, path: 'dst.txt', inTrash: false } })
      prepareFileTransfer(srcSpace.realPath, dstSpace.realPath, true)
      vi.mocked(spacesPathUtils.realTrashPathFromSpace).mockReturnValue('/data/users/john/trash')

      await service.copyMove(user, srcSpace, dstSpace, true, true)

      expect(snapshots()).toEqual([])
    })
  })
})
