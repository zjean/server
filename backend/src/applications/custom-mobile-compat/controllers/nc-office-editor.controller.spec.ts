// Config is mocked because NcDirectEditingService reads it to decide whether an
// office editor exists, and because the token secret has to be deterministic.
vi.mock('../../../configuration/config.environment', () => ({
  configuration: {
    applications: {
      files: {
        editors: {
          onlyoffice: { enabled: true },
          eurooffice: { enabled: false }
        }
      }
    },
    auth: { token: { access: { secret: 'test-secret-for-office-editor-controller' } } }
  }
}))

import { JwtModule } from '@nestjs/jwt'
import { Test, type TestingModule } from '@nestjs/testing'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Mock } from 'vitest'
import { ContextInterceptor } from '../../../infrastructure/context/interceptors/context.interceptor'
import { ContextManager } from '../../../infrastructure/context/services/context-manager.service'
import { OnlyOfficeManager } from '../../files/editors/only-office/only-office-manager.service'
import { UserModel } from '../../users/models/user.model'
import { NcDirectEditingService } from '../services/nc-direct-editing.service'
import { NcOnlyOfficeFileResolver } from '../services/nc-onlyoffice-file-resolver.service'
import { NcOfficeEditorController } from './nc-office-editor.controller'

function makeReq(): FastifyRequest {
  return { headers: { 'user-agent': 'Mozilla/5.0 (iPhone) Mobile Nextcloud-iOS/8.0', host: 'sync-in.example.test' } } as unknown as FastifyRequest
}

function makeRes(): { res: FastifyReply; headers: Record<string, string>; body: () => string } {
  const state = { headers: {} as Record<string, string>, sent: '' }
  const res = {
    header: (k: string, v: string) => {
      state.headers[k] = v
      return res
    },
    send: (b: string) => {
      state.sent = b
      return res
    }
  }
  return { res: res as unknown as FastifyReply, headers: state.headers, body: () => state.sent }
}

const SETTINGS = {
  hasLock: false as const,
  documentServerUrl: 'https://ds.example.test',
  config: { documentType: 'word', token: 'signed', document: { title: 'Report.docx', key: 'k', url: 'https://sync-in.example.test/doc' } }
}

describe(NcOfficeEditorController.name, () => {
  let moduleRef: TestingModule
  let controller: NcOfficeEditorController
  let directEditing: NcDirectEditingService
  let resolve: Mock
  let getSettings: Mock

  beforeAll(async () => {
    resolve = vi.fn()
    getSettings = vi.fn()
    moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'test-secret-for-office-editor-controller' })],
      controllers: [NcOfficeEditorController],
      providers: [
        NcDirectEditingService,
        { provide: NcOnlyOfficeFileResolver, useValue: { resolve } },
        { provide: OnlyOfficeManager, useValue: { getSettings } },
        // ContextInterceptor is declared on the page route, and Nest instantiates
        // it to build the chain even though these cases call the handler
        // directly. In production ContextModule is @Global.
        { provide: ContextManager, useValue: { headerOriginUrl: () => 'https://sync-in.example.test', run: (_c: never, cb: () => unknown) => cb() } }
      ]
    }).compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(NcOfficeEditorController)
    directEditing = moduleRef.get(NcDirectEditingService)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  beforeEach(() => {
    resolve.mockReset()
    getSettings.mockReset()
  })

  async function token(fileId = 42): Promise<string> {
    const user = new UserModel({ id: 7, login: 'alice', email: 'a@b.test', role: 1, permissions: '', applications: [] } as never)
    return directEditing.mintEditToken({ user, fileId })
  }

  function space(realPath: string) {
    return { realPath, url: 'files/personal/Report.docx', dbFile: { path: 'Report.docx', inTrash: false } }
  }

  it('renders the editor page for an advertised office mimetype', async () => {
    resolve.mockResolvedValue(space('/data/alice/Report.docx'))
    getSettings.mockResolvedValue(SETTINGS)
    const r = makeRes()
    await controller.page(makeReq(), await token(), r.res)

    expect(r.headers['Content-Type']).toBe('text/html; charset=utf-8')
    expect(r.body()).toContain('https://ds.example.test/web-apps/apps/api/documents/api.js')
    expect(r.body()).toContain('Report.docx')
  })

  it('allows the document server in the CSP it sends', async () => {
    resolve.mockResolvedValue(space('/data/alice/Report.docx'))
    getSettings.mockResolvedValue(SETTINGS)
    const r = makeRes()
    await controller.page(makeReq(), await token(), r.res)

    expect(r.headers['Content-Security-Policy']).toContain('https://ds.example.test')
    expect(r.headers['X-Frame-Options']).toBe('DENY')
  })

  it('builds the config at PAGE time, not at /open time', async () => {
    // The payload token OnlyOfficeManager signs into the config expires in 60
    // seconds. A config built when the user tapped Edit would already be stale.
    resolve.mockResolvedValue(space('/data/alice/Report.docx'))
    getSettings.mockResolvedValue(SETTINGS)
    const r = makeRes()
    await controller.page(makeReq(), await token(), r.res)
    expect(getSettings).toHaveBeenCalledTimes(1)
  })

  it('refuses a mimetype the catalog never advertised', async () => {
    // getSettings gates on the WIDER ONLY_OFFICE_EXTENSIONS set, so without this
    // layer a hand-built url could open a pdf we deliberately excluded.
    resolve.mockResolvedValue(space('/data/alice/scan.pdf'))
    const r = makeRes()
    await controller.page(makeReq(), await token(), r.res)

    expect(getSettings).not.toHaveBeenCalled()
    expect(r.body()).toContain('cannot be opened in the office editor')
    expect(r.body()).toContain('application/pdf')
  })

  it('renders an error page — not a 4xx — for a missing, garbage or expired token', async () => {
    // A non-200 makes the host webview render its own blank page, so the reason
    // has to arrive as a successful body.
    for (const bad of [undefined, '', 'not.a.jwt']) {
      const r = makeRes()
      await controller.page(makeReq(), bad, r.res)
      expect(r.headers['Content-Type']).toBe('text/html; charset=utf-8')
      expect(r.body()).toContain('invalid or has expired')
      // Every error page must reveal itself on Android too.
      expect(r.body()).toContain('__ncBridge.loaded()')
    }
    expect(resolve).not.toHaveBeenCalled()
  })

  it('renders an error page when the file no longer resolves', async () => {
    resolve.mockResolvedValue(null)
    const r = makeRes()
    await controller.page(makeReq(), await token(999), r.res)
    expect(r.body()).toContain('no longer available')
  })

  it('turns a getSettings failure into an error page instead of a 500', async () => {
    // getSettings throws HttpException for 'Document not found' / 'not
    // supported', and LockConflict handling can throw too. Letting either escape
    // would send the webview a 500 and a blank screen.
    resolve.mockResolvedValue(space('/data/alice/Report.docx'))
    getSettings.mockRejectedValue(new Error('Document not found'))
    const r = makeRes()
    await controller.page(makeReq(), await token(), r.res)
    expect(r.body()).toContain('could not be opened for editing')
    // The reason names server-side paths and must not reach the user.
    expect(r.body()).not.toContain('Document not found')
  })

  it('declares ContextInterceptor on the page route', () => {
    // OnlyOfficeManager builds the document url, the callback url and — without
    // an externalServer — the document server url itself from
    // ContextManager.headerOriginUrl(), which is populated per-route by this
    // interceptor and by nothing else. Without it the config points at
    // `undefined/...` and the editor silently loads nothing.
    const interceptors = Reflect.getMetadata('__interceptors__', NcOfficeEditorController.prototype.page) ?? []
    expect(interceptors).toContain(ContextInterceptor)
  })
})
