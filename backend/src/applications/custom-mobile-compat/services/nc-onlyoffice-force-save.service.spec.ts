// Mock configuration before any imports trigger config-environment loading.
vi.mock('../../../configuration/config.environment', () => ({
  configuration: {
    applications: {
      files: {
        onlyoffice: {
          enabled: true,
          externalServer: 'https://docs.example.test',
          secret: 'test-secret',
          verifySSL: false
        }
      }
    }
  }
}))

import { configuration as mockConfig } from '../../../configuration/config.environment'

import { Test, TestingModule } from '@nestjs/testing'
import { HttpService } from '@nestjs/axios'
import { JwtService } from '@nestjs/jwt'
import { Cache } from '../../../infrastructure/cache/cache.service'
import { NcOnlyOfficeForceSaveService } from './nc-onlyoffice-force-save.service'

describe('NcOnlyOfficeForceSaveService', () => {
  let service: NcOnlyOfficeForceSaveService

  const cacheMock = { get: vi.fn(), set: vi.fn(), del: vi.fn() }
  const jwtMock = { signAsync: vi.fn() }
  const axiosRefMock = vi.fn()
  const httpMock = { axiosRef: axiosRefMock }

  beforeEach(async () => {
    vi.clearAllMocks()
    mockConfig.applications.files.onlyoffice.externalServer = 'https://docs.example.test'

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NcOnlyOfficeForceSaveService,
        { provide: Cache, useValue: cacheMock },
        { provide: JwtService, useValue: jwtMock },
        { provide: HttpService, useValue: httpMock }
      ]
    }).compile()
    service = module.get(NcOnlyOfficeForceSaveService)
  })

  // FileDBProps shape per files-props.interface.ts — only the fields
  // genUniqHashFromFileDBProps consumes matter for keying.
  const fakeSpace: any = {
    dbFile: { id: 1, ownerId: 7, spaceId: 0, spaceExternalRootId: 0, isDir: false, inTrash: false, path: 'docs/a.docx' }
  }

  it('returns { ok: false, "doc server not configured" } when externalServer is unset', async () => {
    mockConfig.applications.files.onlyoffice.externalServer = null
    const out = await service.forceSave(fakeSpace)
    expect(out).toEqual({ ok: false, reason: 'doc server not configured' })
    expect(axiosRefMock).not.toHaveBeenCalled()
  })

  it('returns { ok: true, "no active session" } when the doc key is not cached', async () => {
    cacheMock.get.mockResolvedValue(null)
    const out = await service.forceSave(fakeSpace)
    expect(out).toEqual({ ok: true, reason: 'no active session' })
    expect(axiosRefMock).not.toHaveBeenCalled()
  })

  it('signs the forcesave payload and POSTs to /coauthoring/CommandService.ashx', async () => {
    cacheMock.get.mockResolvedValue('doc-key-1')
    jwtMock.signAsync.mockResolvedValue('signed-jwt')
    axiosRefMock.mockResolvedValue({ data: {} })

    const out = await service.forceSave(fakeSpace)

    expect(jwtMock.signAsync).toHaveBeenCalledWith({ c: 'forcesave', key: 'doc-key-1' }, { secret: 'test-secret', expiresIn: 60 })
    expect(axiosRefMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'https://docs.example.test/coauthoring/CommandService.ashx',
        data: { c: 'forcesave', key: 'doc-key-1', token: 'signed-jwt' }
      })
    )
    expect(out).toEqual({ ok: true })
  })

  it('returns ok=false with the network error message when the doc server is unreachable', async () => {
    cacheMock.get.mockResolvedValue('doc-key-1')
    jwtMock.signAsync.mockResolvedValue('signed-jwt')
    axiosRefMock.mockRejectedValue(new Error('ECONNREFUSED'))

    const out = await service.forceSave(fakeSpace)
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('ECONNREFUSED')
  })
})
