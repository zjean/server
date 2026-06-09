import { JwtModule, JwtService } from '@nestjs/jwt'
import { Test, type TestingModule } from '@nestjs/testing'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { FilesQueries } from '../../files/services/files-queries.service'
import type { UserModel } from '../../users/models/user.model'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcDirectEditingService, NC_DIRECT_EDITING_EDITOR_ID, NC_DIRECT_EDITING_EDITOR_NAME } from '../services/nc-direct-editing.service'
import { NcResponseService } from '../services/nc-response.service'
import { NcDirectEditingController } from './nc-direct-editing.controller'
import { Mock } from 'vitest'

const TEST_SECRET = 'test-secret-for-direct-editing-controller-spec'

function makeReq(extras: Partial<FastifyRequest['headers']> = {}): FastifyRequest & { user: UserModel } {
  return {
    headers: { accept: 'application/json', host: 'sync-in.example.test', 'x-forwarded-proto': 'https', ...extras },
    user: { id: 7, login: 'alice', settings: null }
  } as unknown as FastifyRequest & { user: UserModel }
}

function makeRes(): { res: FastifyReply; headers: Record<string, string> } {
  const state: { res: FastifyReply; headers: Record<string, string> } = { res: undefined as unknown as FastifyReply, headers: {} }
  const res = {
    header: (k: string, v: string) => {
      state.headers[k] = v
      return res
    }
  }
  state.res = res as unknown as FastifyReply
  return state
}

describe(NcDirectEditingController.name, () => {
  let moduleRef: TestingModule
  let controller: NcDirectEditingController
  let getUserFile: Mock
  let getUserFileByPath: Mock
  let jwt: JwtService

  beforeAll(async () => {
    getUserFile = vi.fn()
    getUserFileByPath = vi.fn()
    moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: TEST_SECRET })],
      controllers: [NcDirectEditingController],
      providers: [
        NcDirectEditingService,
        NcResponseService,
        { provide: FilesQueries, useValue: { getUserFile, getUserFileByPath } },
        { provide: NcBasicAuthGuard, useValue: { canActivate: () => true } }
      ]
    })
      .overrideGuard(NcBasicAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(NcDirectEditingController)
    jwt = moduleRef.get(JwtService)
    // Stub only baseUrl() so tests are independent of local OIDC config presence.
    vi.spyOn(moduleRef.get(NcResponseService), 'baseUrl').mockReturnValue('https://sync-in.example.test')
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  beforeEach(() => {
    getUserFile.mockReset()
    getUserFileByPath.mockReset()
    // Production code reads configuration.auth.token.access.secret. Override
    // in tests so JWT round-trips work without a real config file.
    vi.resetModules()
    process.env.NC_DIRECT_EDITING_TEST = 'true'
  })

  describe('GET /ocs/v2.php/apps/files/api/v1/directEditing (info)', () => {
    it('returns the editor catalog wrapped in the OCS envelope', async () => {
      const r = makeRes()
      const out = await controller.info(makeReq(), r.res)

      expect(r.headers['Content-Type']).toBe('application/json; charset=utf-8')
      expect(out.ocs.meta.status).toBe('ok')
      expect(out.ocs.meta.statuscode).toBe(200)
      expect(out.ocs.data.editors).toBeDefined()
      expect(out.ocs.data.creators).toBeDefined()
    })

    it('keys editors by id (matching upstream wire format)', async () => {
      const r = makeRes()
      const out = await controller.info(makeReq(), r.res)

      // Upstream `apps/files/lib/Service/DirectEditingService.php` builds
      // `$capabilities['editors'][$id]` — a dict keyed by id, not an array.
      // NextcloudKit's NKEditorDetailsResponse parses it as
      // `[String: NKEditorDetailsEditor]`. An array shape would silently
      // fail to parse on iOS.
      expect(out.ocs.data.editors[NC_DIRECT_EDITING_EDITOR_ID]).toBeDefined()
      expect(out.ocs.data.editors[NC_DIRECT_EDITING_EDITOR_ID].name).toBe(NC_DIRECT_EDITING_EDITOR_NAME)
    })

    it('rejects XML-only Accept headers (we only emit JSON for the OCS surface)', async () => {
      const req = makeReq({ accept: 'application/xml' })
      const r = makeRes()
      await expect(controller.info(req, r.res)).rejects.toMatchObject({
        message: expect.stringContaining('XML')
      })
    })
  })

  describe('POST /ocs/v2.php/apps/files/api/v1/directEditing/open', () => {
    it('returns an absolute URL with a fresh token bound to user+file', async () => {
      getUserFile.mockResolvedValue({ id: 42, path: 'files/personal/notes.md', mime: 'text-markdown' })
      const r = makeRes()
      const out = await controller.open(makeReq(), r.res, '/notes.md', NC_DIRECT_EDITING_EDITOR_ID, '42')

      expect(out.ocs.meta.status).toBe('ok')
      expect(typeof out.ocs.data.url).toBe('string')
      expect(out.ocs.data.url).toMatch(/^https:\/\/sync-in\.example\.test\//)
      // The URL contains a token — extract & verify
      const match = out.ocs.data.url.match(/[?&]token=([^&]+)/)
      expect(match).not.toBeNull()
      const token = decodeURIComponent(match![1])
      const decoded = jwt.decode(token) as { identity: { id: number; login: string }; fileId: number; scope: string }
      expect(decoded.identity.id).toBe(7)
      expect(decoded.identity.login).toBe('alice')
      expect(decoded.fileId).toBe(42)
      expect(decoded.scope).toBe('nc-direct-editing:edit')
    })

    it('points the URL at the in-app text editor (a path on this server)', async () => {
      getUserFile.mockResolvedValue({ id: 42, path: 'files/personal/notes.md', mime: 'text-markdown' })
      const r = makeRes()
      const out = await controller.open(makeReq(), r.res, '/notes.md', NC_DIRECT_EDITING_EDITOR_ID, '42')

      // We commit to a stable path so iOS WKWebView always lands on it.
      expect(out.ocs.data.url).toContain('/custom-mobile-compat/text-editor')
    })

    it('rejects 400 when both fileId and path are absent', async () => {
      const r = makeRes()
      await expect(controller.open(makeReq(), r.res, undefined, NC_DIRECT_EDITING_EDITOR_ID, undefined)).rejects.toMatchObject({
        status: 400
      })
    })

    it('falls back to path lookup when fileId is absent (NCViewer never sends fileId)', async () => {
      getUserFileByPath.mockResolvedValue(42)
      getUserFile.mockResolvedValue({ id: 42, path: 'files/personal/notes.md' })
      const r = makeRes()
      const out = await controller.open(makeReq(), r.res, '/notes.md', NC_DIRECT_EDITING_EDITOR_ID, undefined)
      expect(out.ocs.meta.status).toBe('ok')
      expect(getUserFileByPath).toHaveBeenCalledWith(7, '.', 'notes.md')
    })

    it('path lookup: parses sub-folder path correctly', async () => {
      getUserFileByPath.mockResolvedValue(55)
      getUserFile.mockResolvedValue({ id: 55, path: 'files/personal/Docs/notes.md' })
      const r = makeRes()
      await controller.open(makeReq(), r.res, '/Docs/notes.md', NC_DIRECT_EDITING_EDITOR_ID, undefined)
      expect(getUserFileByPath).toHaveBeenCalledWith(7, 'Docs', 'notes.md')
    })

    it('returns 404 when path lookup finds no file', async () => {
      getUserFileByPath.mockResolvedValue(null)
      const r = makeRes()
      await expect(controller.open(makeReq(), r.res, '/missing.md', NC_DIRECT_EDITING_EDITOR_ID, undefined)).rejects.toMatchObject({
        status: 404
      })
    })

    it('Android: accepts path+editorId from JSON body (no query params)', async () => {
      getUserFileByPath.mockResolvedValue(42)
      getUserFile.mockResolvedValue({ id: 42, path: 'files/personal/notes.md' })
      const r = makeRes()
      // Android sends empty query params; path+editorId arrive as body fields
      const out = await controller.open(makeReq(), r.res, undefined, undefined, undefined, '/notes.md', NC_DIRECT_EDITING_EDITOR_ID)
      expect(out.ocs.meta.status).toBe('ok')
      expect(getUserFileByPath).toHaveBeenCalledWith(7, '.', 'notes.md')
    })

    it('rejects unknown editorId (catalog drift / spoofed iOS)', async () => {
      getUserFile.mockResolvedValue({ id: 42, path: 'files/personal/notes.md', mime: 'text-markdown' })
      const r = makeRes()
      await expect(controller.open(makeReq(), r.res, '/notes.md', 'unknown-editor', '42')).rejects.toMatchObject({
        status: 400
      })
    })

    it('returns 404 when the file does not belong to the user (or does not exist)', async () => {
      getUserFile.mockResolvedValue(null)
      const r = makeRes()
      await expect(controller.open(makeReq(), r.res, '/notes.md', NC_DIRECT_EDITING_EDITOR_ID, '999')).rejects.toMatchObject({
        status: 404
      })
    })

    it('looks up the file using the authenticated user (no cross-tenant peek)', async () => {
      getUserFile.mockResolvedValue({ id: 42, path: 'files/personal/notes.md' })
      const r = makeRes()
      await controller.open(makeReq(), r.res, '/notes.md', NC_DIRECT_EDITING_EDITOR_ID, '42')

      // First arg of getUserFile must be the *authenticated* userId from req.user,
      // never something derived from the request body/query.
      expect(getUserFile).toHaveBeenCalledTimes(1)
      expect(getUserFile.mock.calls[0][0]).toBe(7)
      expect(getUserFile.mock.calls[0][1]).toBe(42)
    })
  })
})
