import { HttpException, HttpStatus } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { FileRecent } from '../../files/schemas/file-recent.interface'
import { FilesRecents } from '../../files/services/files-recents.service'
import type { UserModel } from '../../users/models/user.model'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcPathResolverService } from '../services/nc-path-resolver.service'
import { NcResponseService } from '../services/nc-response.service'
import { NcRecommendationsController } from './nc-recommendations.controller'

function makeReq(accept: string = 'application/json'): FastifyRequest & { user: UserModel } {
  return { headers: { accept }, user: { id: 7, login: 'alice', settings: null } } as unknown as FastifyRequest & { user: UserModel }
}

function makeRes(): { res: FastifyReply; headers: Record<string, string> } {
  const headers: Record<string, string> = {}
  const res = {
    header: (k: string, v: string) => {
      headers[k] = v
      return res
    }
  }
  return { res: res as unknown as FastifyReply, headers }
}

function recent(overrides: Partial<FileRecent> = {}): FileRecent {
  return {
    id: 100,
    ownerId: 1,
    spaceId: 0,
    shareId: 0,
    path: 'files/personal/Documents',
    name: 'report.docx',
    mime: 'application-vnd.openxmlformats-officedocument.wordprocessingml.document',
    mtime: 1714742400000,
    ...overrides
  } as FileRecent
}

describe(NcRecommendationsController.name, () => {
  let moduleRef: TestingModule
  let controller: NcRecommendationsController
  let getRecents: jest.Mock

  beforeAll(async () => {
    getRecents = jest.fn()
    moduleRef = await Test.createTestingModule({
      controllers: [NcRecommendationsController],
      providers: [
        NcResponseService,
        NcPathResolverService,
        { provide: FilesRecents, useValue: { getRecents } },
        { provide: NcBasicAuthGuard, useValue: { canActivate: () => true } }
      ]
    })
      .overrideGuard(NcBasicAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(NcRecommendationsController)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  beforeEach(() => {
    getRecents.mockReset()
  })

  it('returns an OCS envelope with mapped entries', async () => {
    getRecents.mockResolvedValue([recent()])
    const { res, headers } = makeRes()

    const out = await controller.recommendations(makeReq(), res)

    expect(out).toEqual({
      ocs: {
        meta: { status: 'ok', statuscode: 200, message: '' },
        data: {
          entries: [
            {
              id: 100,
              timestamp: 1714742400,
              name: 'report.docx',
              directory: '/Documents',
              extension: 'docx',
              mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              hasPreview: false,
              reason: 'recent'
            }
          ]
        }
      }
    })
    expect(headers['Content-Type']).toBe('application/json; charset=utf-8')
  })

  it('returns an empty entries array when there are no recents (never 404)', async () => {
    getRecents.mockResolvedValue([])
    const { res } = makeRes()

    const out = await controller.recommendations(makeReq(), res)

    expect(out.ocs.data.entries).toEqual([])
    expect(out.ocs.meta.statuscode).toBe(200)
  })

  it('forwards the authenticated user to FilesRecents.getRecents', async () => {
    getRecents.mockResolvedValue([])
    const { res } = makeRes()

    await controller.recommendations(makeReq(), res)

    expect(getRecents).toHaveBeenCalledTimes(1)
    expect(getRecents.mock.calls[0][0]).toMatchObject({ id: 7, login: 'alice' })
  })

  it('uses the default limit when none is provided', async () => {
    getRecents.mockResolvedValue([])
    const { res } = makeRes()

    await controller.recommendations(makeReq(), res, undefined)

    expect(getRecents.mock.calls[0][1]).toBe(10)
  })

  it('passes through a valid limit', async () => {
    getRecents.mockResolvedValue([])
    const { res } = makeRes()

    await controller.recommendations(makeReq(), res, '5')

    expect(getRecents.mock.calls[0][1]).toBe(5)
  })

  it('clamps limit to 50', async () => {
    getRecents.mockResolvedValue([])
    const { res } = makeRes()

    await controller.recommendations(makeReq(), res, '999')

    expect(getRecents.mock.calls[0][1]).toBe(50)
  })

  it('falls back to the default for non-numeric or non-positive limit', async () => {
    getRecents.mockResolvedValue([])
    const { res } = makeRes()

    await controller.recommendations(makeReq(), res, 'foo')
    expect(getRecents.mock.calls[0][1]).toBe(10)
    getRecents.mockClear()

    await controller.recommendations(makeReq(), res, '-5')
    expect(getRecents.mock.calls[0][1]).toBe(10)
    getRecents.mockClear()

    await controller.recommendations(makeReq(), res, '0')
    expect(getRecents.mock.calls[0][1]).toBe(10)
  })

  it('rejects requests that demand XML', async () => {
    getRecents.mockResolvedValue([])
    const { res } = makeRes()

    await expect(controller.recommendations(makeReq('application/xml'), res)).rejects.toMatchObject({
      status: HttpStatus.NOT_ACCEPTABLE
    } as Partial<HttpException>)
    expect(getRecents).not.toHaveBeenCalled()
  })

  it('drops recents outside the user’s resolved home (would 404 on iOS tap)', async () => {
    // First recent is under personal home, second is in some other space.
    getRecents.mockResolvedValue([
      recent({ id: 1, path: 'files/personal/Reports', name: 'q1.pdf' }),
      recent({ id: 2, path: 'files/team-marketing/Brand', name: 'logo.svg' })
    ])
    const { res } = makeRes()

    const out = await controller.recommendations(makeReq(), res)

    expect(out.ocs.data.entries.map((e) => e.id)).toEqual([1])
  })
})
