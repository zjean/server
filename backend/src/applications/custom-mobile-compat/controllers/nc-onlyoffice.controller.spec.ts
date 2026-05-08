import { HttpException, HttpStatus } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { OnlyOfficeManager } from '../../files/editors/only-office/only-office-manager.service'
import { OnlyOfficeGuard } from '../../files/editors/only-office/only-office.guard'
import { FilesManager } from '../../files/services/files-manager.service'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcOnlyOfficeFileResolver } from '../services/nc-onlyoffice-file-resolver.service'
import { NcOnlyOfficeForceSaveService } from '../services/nc-onlyoffice-force-save.service'
import { NcOnlyOfficeTranslatorService } from '../services/nc-onlyoffice-translator.service'
import { NcOnlyOfficeCallbackController, NcOnlyOfficeController } from './nc-onlyoffice.controller'

describe('NcOnlyOfficeController', () => {
  let controller: NcOnlyOfficeController

  const onlyOfficeManagerMock = { getSettings: jest.fn(), callBack: jest.fn() }
  const translatorMock = { toNcEnvelope: jest.fn() }
  const resolverMock = { resolve: jest.fn(), resolveChild: jest.fn() }
  const filesManagerMock = { mkFile: jest.fn() }
  const forceSaveMock = { forceSave: jest.fn() }

  beforeEach(async () => {
    jest.clearAllMocks()
    const module: TestingModule = await Test.createTestingModule({
      controllers: [NcOnlyOfficeController],
      providers: [
        { provide: OnlyOfficeManager, useValue: onlyOfficeManagerMock },
        { provide: NcOnlyOfficeTranslatorService, useValue: translatorMock },
        { provide: NcOnlyOfficeFileResolver, useValue: resolverMock },
        { provide: FilesManager, useValue: filesManagerMock },
        { provide: NcOnlyOfficeForceSaveService, useValue: forceSaveMock }
      ]
    })
      .overrideGuard(NcBasicAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()
    controller = module.get(NcOnlyOfficeController)
  })

  it('should be defined', () => {
    expect(controller).toBeDefined()
  })

  describe('config()', () => {
    const fakeUser: any = { id: 7, login: 'jane' }
    const fakeReq: any = { user: fakeUser, headers: { 'user-agent': 'test' } }

    it('returns 400 when fileId is missing', async () => {
      await expect(controller.config(fakeReq, undefined)).rejects.toThrow(/fileId/)
      try {
        await controller.config(fakeReq, undefined)
      } catch (e) {
        expect((e as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST)
      }
    })

    it('returns 400 when fileId is non-numeric', async () => {
      await expect(controller.config(fakeReq, 'abc')).rejects.toThrow(HttpException)
    })

    it('returns 404 when file does not belong to user', async () => {
      resolverMock.resolve.mockResolvedValue(null)
      await expect(controller.config(fakeReq, '42')).rejects.toThrow(HttpException)
      try {
        await controller.config(fakeReq, '42')
      } catch (e) {
        expect((e as HttpException).getStatus()).toBe(HttpStatus.NOT_FOUND)
      }
    })

    it('resolves fileId, calls OnlyOfficeManager.getSettings, returns translator output', async () => {
      const fakeSpace = { url: 'files/personal/docs/a.docx' }
      resolverMock.resolve.mockResolvedValue(fakeSpace)
      const fakeSyncIn = { documentServerUrl: 'x', config: {}, hasLock: false }
      onlyOfficeManagerMock.getSettings.mockResolvedValue(fakeSyncIn)
      translatorMock.toNcEnvelope.mockReturnValue({ shaped: true, editorConfig: {} })

      const out = await controller.config(fakeReq, '42')

      expect(resolverMock.resolve).toHaveBeenCalledWith(fakeUser, 42)
      expect(onlyOfficeManagerMock.getSettings).toHaveBeenCalledWith(fakeUser, fakeSpace, fakeReq)
      expect(translatorMock.toNcEnvelope).toHaveBeenCalledWith(fakeSyncIn)
      expect(out).toMatchObject({ shaped: true })
    })

    it('rewrites editorConfig.callbackUrl to /index.php/apps/onlyoffice/track preserving the user token', async () => {
      resolverMock.resolve.mockResolvedValue({ url: 'x' })
      onlyOfficeManagerMock.getSettings.mockResolvedValue({})
      translatorMock.toNcEnvelope.mockReturnValue({
        editorConfig: {
          callbackUrl: 'https://sync-in.test/api/spaces/onlyoffice/callback/personal/a.docx?token=user-jwt-abc'
        }
      })

      const out = await controller.config(fakeReq, '42')
      const u = new URL((out as any).editorConfig.callbackUrl)
      expect(u.pathname).toBe('/index.php/apps/onlyoffice/track')
      expect(u.searchParams.get('fileId')).toBe('42')
      expect(u.searchParams.get('token')).toBe('user-jwt-abc')
      expect(u.origin).toBe('https://sync-in.test')
    })

    it('leaves callbackUrl unchanged when the original has no token query (defensive)', async () => {
      resolverMock.resolve.mockResolvedValue({ url: 'x' })
      onlyOfficeManagerMock.getSettings.mockResolvedValue({})
      translatorMock.toNcEnvelope.mockReturnValue({
        editorConfig: { callbackUrl: 'https://sync-in.test/api/spaces/onlyoffice/callback/personal/a.docx' }
      })

      const out = await controller.config(fakeReq, '42')
      expect((out as any).editorConfig.callbackUrl).toBe('https://sync-in.test/api/spaces/onlyoffice/callback/personal/a.docx')
    })
  })

  describe('empty()', () => {
    const fakeUser: any = { id: 7, login: 'jane' }
    const fakeReq: any = { user: fakeUser }

    it('returns 400 when fileId missing', async () => {
      await expect(controller.empty(fakeReq, undefined, 'a.docx')).rejects.toThrow(HttpException)
    })

    it('returns 400 when name missing', async () => {
      await expect(controller.empty(fakeReq, '5', undefined)).rejects.toThrow(HttpException)
    })

    it('returns 400 for unsupported template extension', async () => {
      await expect(controller.empty(fakeReq, '5', 'a.pdf')).rejects.toThrow(/unsupported/)
    })

    it('returns 404 when parent does not resolve', async () => {
      resolverMock.resolveChild.mockResolvedValue(null)
      await expect(controller.empty(fakeReq, '5', 'a.docx')).rejects.toThrow(HttpException)
    })

    it('creates the file via FilesManager.mkFile and returns the name', async () => {
      const fakeSpace = { url: 'files/personal/docs/a.docx' }
      resolverMock.resolveChild.mockResolvedValue(fakeSpace)
      filesManagerMock.mkFile.mockResolvedValue(undefined)

      const out = await controller.empty(fakeReq, '5', 'a.docx')

      expect(resolverMock.resolveChild).toHaveBeenCalledWith(fakeUser, 5, 'a.docx')
      // checkDocument=true triggers the sample-template copy path in mkFile.
      expect(filesManagerMock.mkFile).toHaveBeenCalledWith(fakeUser, fakeSpace, false, true, true)
      expect(out).toEqual({ name: 'a.docx' })
    })

    it('accepts xlsx and pptx in addition to docx', async () => {
      resolverMock.resolveChild.mockResolvedValue({ url: 'x' })
      filesManagerMock.mkFile.mockResolvedValue(undefined)

      await expect(controller.empty(fakeReq, '5', 'a.xlsx')).resolves.toEqual({ name: 'a.xlsx' })
      await expect(controller.empty(fakeReq, '5', 'a.pptx')).resolves.toEqual({ name: 'a.pptx' })
    })
  })

  describe('save()', () => {
    const fakeUser: any = { id: 7, login: 'jane' }
    const fakeReq: any = { user: fakeUser }

    it('returns error envelope when fileId is missing', async () => {
      const out = await controller.save(fakeReq, undefined)
      expect(out).toEqual({ status: 'error', reason: 'fileId required' })
    })

    it('returns error envelope when file does not resolve', async () => {
      resolverMock.resolve.mockResolvedValue(null)
      const out = await controller.save(fakeReq, '42')
      expect(out).toEqual({ status: 'error', reason: 'file not found' })
    })

    it('issues forceSave and returns ok on success', async () => {
      const fakeSpace = { url: 'files/personal/docs/a.docx' }
      resolverMock.resolve.mockResolvedValue(fakeSpace)
      forceSaveMock.forceSave.mockResolvedValue({ ok: true })

      const out = await controller.save(fakeReq, '42')

      expect(forceSaveMock.forceSave).toHaveBeenCalledWith(fakeSpace)
      expect(out).toEqual({ status: 'ok' })
    })

    it('returns error envelope when forceSave fails', async () => {
      resolverMock.resolve.mockResolvedValue({ url: 'x' })
      forceSaveMock.forceSave.mockResolvedValue({ ok: false, reason: 'ECONNREFUSED' })

      const out = await controller.save(fakeReq, '42')
      expect(out).toEqual({ status: 'error', reason: 'ECONNREFUSED' })
    })
  })
})

describe('NcOnlyOfficeCallbackController', () => {
  let controller: NcOnlyOfficeCallbackController

  const onlyOfficeManagerMock = { getSettings: jest.fn(), callBack: jest.fn() }
  const resolverMock = { resolve: jest.fn() }

  beforeEach(async () => {
    jest.clearAllMocks()
    const module: TestingModule = await Test.createTestingModule({
      controllers: [NcOnlyOfficeCallbackController],
      providers: [
        { provide: OnlyOfficeManager, useValue: onlyOfficeManagerMock },
        { provide: NcOnlyOfficeFileResolver, useValue: resolverMock }
      ]
    })
      .overrideGuard(OnlyOfficeGuard)
      .useValue({ canActivate: () => true })
      .compile()
    controller = module.get(NcOnlyOfficeCallbackController)
  })

  it('should be defined', () => {
    expect(controller).toBeDefined()
  })

  describe('track()', () => {
    const fakeUser: any = { id: 7, login: 'jane' }
    const fakeReq: any = { user: fakeUser }

    it('returns error envelope when fileId is missing', async () => {
      const out = await controller.track(fakeReq, undefined, { token: 'oo-payload' })
      expect(out).toEqual({ error: 'fileId required' })
    })

    it('returns error envelope when fileId is non-numeric', async () => {
      const out = await controller.track(fakeReq, 'abc', { token: 'oo-payload' })
      expect(out).toEqual({ error: 'fileId required' })
    })

    it('returns error envelope when file is unresolvable', async () => {
      resolverMock.resolve.mockResolvedValue(null)
      const out = await controller.track(fakeReq, '42', { token: 'oo-payload' })
      expect(out).toEqual({ error: 'file not found' })
    })

    it('returns error envelope when body has no token', async () => {
      resolverMock.resolve.mockResolvedValue({ url: 'x' })
      const out = await controller.track(fakeReq, '42', {})
      expect(out).toEqual({ error: 'callback token required' })
    })

    it('dispatches valid callbacks into OnlyOfficeManager.callBack', async () => {
      const fakeSpace = { url: 'files/personal/docs/a.docx' }
      resolverMock.resolve.mockResolvedValue(fakeSpace)
      onlyOfficeManagerMock.callBack.mockResolvedValue({ error: 0 })

      const out = await controller.track(fakeReq, '42', { token: 'oo-payload-jwt' })

      expect(resolverMock.resolve).toHaveBeenCalledWith(fakeUser, 42)
      expect(onlyOfficeManagerMock.callBack).toHaveBeenCalledWith(fakeUser, fakeSpace, 'oo-payload-jwt')
      expect(out).toEqual({ error: 0 })
    })
  })
})
