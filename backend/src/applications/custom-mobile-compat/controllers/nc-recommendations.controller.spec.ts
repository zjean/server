import { Test, TestingModule } from '@nestjs/testing'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { FileRecent } from '../../files/schemas/file-recent.interface'
import { FilesRecents } from '../../files/services/files-recents.service'
import type { UserModel } from '../../users/models/user.model'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcPathResolverService } from '../services/nc-path-resolver.service'
import { NcRecommendationsController } from './nc-recommendations.controller'
import { Mock } from 'vitest'

// NextcloudKit's getRecommendedFiles sends Accept: application/xml; the
// controller must reply with XML at path ocs → data → recommendations →
// element. These tests assert the wire format directly so a future
// refactor can't silently regress to JSON.

function makeReq(): FastifyRequest & { user: UserModel } {
  return { headers: { accept: 'application/xml' }, user: { id: 7, login: 'alice', settings: null } } as unknown as FastifyRequest & {
    user: UserModel
  }
}

function makeRes(): { res: FastifyReply; headers: Record<string, string>; body?: string } {
  const state: { res: FastifyReply; headers: Record<string, string>; body?: string } = { res: undefined as unknown as FastifyReply, headers: {} }
  const res = {
    header: (k: string, v: string) => {
      state.headers[k] = v
      return res
    },
    send: (payload: string) => {
      state.body = payload
      return res
    }
  }
  state.res = res as unknown as FastifyReply
  return state
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
  let getRecents: Mock

  beforeAll(async () => {
    getRecents = vi.fn()
    moduleRef = await Test.createTestingModule({
      controllers: [NcRecommendationsController],
      providers: [
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

  it('responds with XML at the OCS path SwiftyXMLParser navigates', async () => {
    getRecents.mockResolvedValue([recent()])
    const r = makeRes()

    await controller.recommendations(makeReq(), r.res)

    expect(r.headers['Content-Type']).toBe('application/xml; charset=utf-8')
    expect(r.body).toContain('<?xml')
    // Path navigated by NK: ocs → data → recommendations → element
    expect(r.body).toMatch(
      /<ocs>[\s\S]*<data>[\s\S]*<recommendations>[\s\S]*<element>[\s\S]*<\/element>[\s\S]*<\/recommendations>[\s\S]*<\/data>[\s\S]*<\/ocs>/
    )
  })

  it('emits enabled=1 sibling of recommendations (matches upstream RecommendationController->index)', async () => {
    getRecents.mockResolvedValue([])
    const r = makeRes()

    await controller.recommendations(makeReq(), r.res)

    expect(r.body).toContain('<enabled>1</enabled>')
  })

  it('emits each entry with the field types NK parses', async () => {
    getRecents.mockResolvedValue([recent({ id: 42, name: 'photo.jpg', mime: 'image-jpeg' })])
    const r = makeRes()

    await controller.recommendations(makeReq(), r.res)

    // id is text, NK reads as String
    expect(r.body).toContain('<id>42</id>')
    // hasPreview is text "1"/"0", NK does literal text == "1"
    expect(r.body).toContain('<hasPreview>1</hasPreview>')
    expect(r.body).toContain('<mimeType>image/jpeg</mimeType>')
    expect(r.body).toContain('<extension>jpg</extension>')
    expect(r.body).toContain('<directory>/Documents</directory>')
    expect(r.body).toContain('<reason>recent</reason>')
    expect(r.body).toContain('<timestamp>1714742400</timestamp>')
  })

  it('emits an empty <recommendations> container when there are no recents (never 404)', async () => {
    getRecents.mockResolvedValue([])
    const r = makeRes()

    await controller.recommendations(makeReq(), r.res)

    // Empty list is a valid carousel state. The container must still exist
    // so NK's parser sees the path; it'll just yield zero <element>s.
    expect(r.body).toMatch(/<recommendations>[\s\n]*<\/recommendations>|<recommendations\s*\/>|<recommendations><\/recommendations>/)
    expect(r.body).not.toContain('<element>')
    expect(r.body).toContain('<status>ok</status>')
    expect(r.body).toContain('<statuscode>200</statuscode>')
  })

  it('forwards the authenticated user to FilesRecents.getRecents', async () => {
    getRecents.mockResolvedValue([])
    const r = makeRes()

    await controller.recommendations(makeReq(), r.res)

    expect(getRecents).toHaveBeenCalledTimes(1)
    expect(getRecents.mock.calls[0][0]).toMatchObject({ id: 7, login: 'alice' })
  })

  it('uses the default limit when none is provided', async () => {
    getRecents.mockResolvedValue([])
    const r = makeRes()

    await controller.recommendations(makeReq(), r.res, undefined)

    expect(getRecents.mock.calls[0][1]).toBe(10)
  })

  it('passes through a valid limit', async () => {
    getRecents.mockResolvedValue([])
    const r = makeRes()

    await controller.recommendations(makeReq(), r.res, '5')

    expect(getRecents.mock.calls[0][1]).toBe(5)
  })

  it('clamps limit to 50', async () => {
    getRecents.mockResolvedValue([])
    const r = makeRes()

    await controller.recommendations(makeReq(), r.res, '999')

    expect(getRecents.mock.calls[0][1]).toBe(50)
  })

  it('falls back to the default for non-numeric, zero, or negative limit', async () => {
    getRecents.mockResolvedValue([])
    const r = makeRes()

    await controller.recommendations(makeReq(), r.res, 'foo')
    expect(getRecents.mock.calls[0][1]).toBe(10)
    getRecents.mockClear()

    await controller.recommendations(makeReq(), r.res, '-5')
    expect(getRecents.mock.calls[0][1]).toBe(10)
    getRecents.mockClear()

    await controller.recommendations(makeReq(), r.res, '0')
    expect(getRecents.mock.calls[0][1]).toBe(10)
  })

  it('drops recents outside the user’s resolved home (would 404 on iOS tap)', async () => {
    getRecents.mockResolvedValue([
      recent({ id: 1, path: 'files/personal/Reports', name: 'q1.pdf' }),
      recent({ id: 2, path: 'files/team-marketing/Brand', name: 'logo.svg' })
    ])
    const r = makeRes()

    await controller.recommendations(makeReq(), r.res)

    // Only the in-home file's id should appear in an <id> element.
    const ids = Array.from(r.body!.matchAll(/<id>(\d+)<\/id>/g)).map((m) => m[1])
    expect(ids).toEqual(['1'])
  })
})
