import { HttpException, HttpStatus } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { OnlyOfficeManager } from '../../files/modules/only-office/only-office-manager.service'
import { FilesQueries } from '../../files/services/files-queries.service'
import { SpacesManager } from '../../spaces/services/spaces-manager.service'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcOnlyOfficeTranslatorService } from '../services/nc-onlyoffice-translator.service'
import { NcOnlyOfficeCallbackController, NcOnlyOfficeController } from './nc-onlyoffice.controller'

describe('NcOnlyOfficeController', () => {
  let controller: NcOnlyOfficeController

  const onlyOfficeManagerMock = { getSettings: jest.fn(), callBack: jest.fn() }
  const filesQueriesMock = { getUserFile: jest.fn() }
  const spacesManagerMock = { spaceEnv: jest.fn() }
  const translatorMock = { toNcEnvelope: jest.fn() }

  beforeEach(async () => {
    jest.clearAllMocks()
    const module: TestingModule = await Test.createTestingModule({
      controllers: [NcOnlyOfficeController],
      providers: [
        { provide: OnlyOfficeManager, useValue: onlyOfficeManagerMock },
        { provide: FilesQueries, useValue: filesQueriesMock },
        { provide: SpacesManager, useValue: spacesManagerMock },
        { provide: NcOnlyOfficeTranslatorService, useValue: translatorMock }
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
      filesQueriesMock.getUserFile.mockResolvedValue(null)
      await expect(controller.config(fakeReq, '42')).rejects.toThrow(HttpException)
      try {
        await controller.config(fakeReq, '42')
      } catch (e) {
        expect((e as HttpException).getStatus()).toBe(HttpStatus.NOT_FOUND)
      }
    })

    it('resolves fileId, calls OnlyOfficeManager.getSettings, returns translator output', async () => {
      filesQueriesMock.getUserFile.mockResolvedValue({ id: 42, path: 'docs/a.docx' })
      const fakeSpace = { url: 'files/personal/docs/a.docx' }
      spacesManagerMock.spaceEnv.mockResolvedValue(fakeSpace)
      const fakeSyncIn = { documentServerUrl: 'x', config: {}, hasLock: false }
      onlyOfficeManagerMock.getSettings.mockResolvedValue(fakeSyncIn)
      translatorMock.toNcEnvelope.mockReturnValue({ shaped: true })

      const out = await controller.config(fakeReq, '42')

      expect(filesQueriesMock.getUserFile).toHaveBeenCalledWith(7, 42)
      expect(spacesManagerMock.spaceEnv).toHaveBeenCalledWith(fakeUser, ['files', 'personal', 'docs', 'a.docx'])
      expect(onlyOfficeManagerMock.getSettings).toHaveBeenCalledWith(fakeUser, fakeSpace, fakeReq)
      expect(translatorMock.toNcEnvelope).toHaveBeenCalledWith(fakeSyncIn)
      expect(out).toEqual({ shaped: true })
    })
  })

  it('empty() still throws 501 (phase 4)', () => {
    expect(() => controller.empty()).toThrow(HttpException)
  })

  it('save() still throws 501 (phase 4)', () => {
    expect(() => controller.save()).toThrow(HttpException)
  })
})

describe('NcOnlyOfficeCallbackController (stub)', () => {
  let controller: NcOnlyOfficeCallbackController

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [NcOnlyOfficeCallbackController],
      providers: []
    }).compile()
    controller = module.get(NcOnlyOfficeCallbackController)
  })

  it('should be defined', () => {
    expect(controller).toBeDefined()
  })

  it('track() throws 501 in phase 1', () => {
    expect(() => controller.track()).toThrow(HttpException)
  })
})
