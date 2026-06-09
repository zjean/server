import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JwtModule } from '@nestjs/jwt'
import { Test, type TestingModule } from '@nestjs/testing'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { FilesManager } from '../../files/services/files-manager.service'
import { FilesQueries } from '../../files/services/files-queries.service'
import { genEtag } from '../../files/utils/files'
import type { SpaceEnv } from '../../spaces/models/space-env.model'
import { SpacesManager } from '../../spaces/services/spaces-manager.service'
import { UserModel } from '../../users/models/user.model'
import { NcDirectEditingService } from '../services/nc-direct-editing.service'
import { NcTextEditorController } from './nc-text-editor.controller'
import { Mock } from 'vitest'

const TEST_SECRET = 'test-secret-for-text-editor-controller'

function makeRes(): { res: FastifyReply; headers: Record<string, string>; status: number; body?: unknown; sent: boolean } {
  const state = {
    res: undefined as unknown as FastifyReply,
    headers: {} as Record<string, string>,
    status: 200,
    body: undefined as unknown,
    sent: false
  }
  const res = {
    header: (k: string, v: string) => {
      state.headers[k] = v
      return res
    },
    status: (s: number) => {
      state.status = s
      return res
    },
    send: (payload?: unknown) => {
      state.body = payload
      state.sent = true
      return res
    }
  }
  state.res = res as unknown as FastifyReply
  return state
}

function makeUser(overrides: Partial<UserModel> = {}): UserModel {
  return new UserModel({
    id: 7,
    login: 'alice',
    email: 'alice@example.test',
    firstName: 'Alice',
    lastName: 'Example',
    language: 'en',
    role: 1,
    permissions: '',
    applications: [],
    ...overrides
  } as Partial<UserModel>)
}

function makeSpace(realPath: string, overrides: Partial<SpaceEnv> = {}): SpaceEnv {
  return {
    realPath,
    relativeUrl: '/notes.md',
    url: 'files/personal/notes.md',
    dbFile: { id: 42, name: 'notes.md', path: '/personal', mime: 'text/markdown', size: 0 } as unknown as SpaceEnv['dbFile'],
    permissions: 'r,m,d',
    envPermissions: 'r,m,d',
    ...overrides
  } as unknown as SpaceEnv
}

describe(NcTextEditorController.name, () => {
  let moduleRef: TestingModule
  let controller: NcTextEditorController
  let directEditing: NcDirectEditingService
  let getUserFile: Mock
  let spaceEnv: Mock
  let saveStream: Mock
  let workDir: string

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'nc-text-editor-spec-'))

    getUserFile = vi.fn()
    spaceEnv = vi.fn()
    saveStream = vi.fn()

    moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: TEST_SECRET, global: true })],
      controllers: [NcTextEditorController],
      providers: [
        NcDirectEditingService,
        { provide: FilesQueries, useValue: { getUserFile } },
        { provide: SpacesManager, useValue: { spaceEnv } },
        { provide: FilesManager, useValue: { saveStream } }
      ]
    }).compile()
    moduleRef.useLogger(['fatal'])

    controller = moduleRef.get(NcTextEditorController)
    directEditing = moduleRef.get(NcDirectEditingService)
  })

  afterAll(async () => {
    await moduleRef.close()
    rmSync(workDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    getUserFile.mockReset()
    spaceEnv.mockReset()
    saveStream.mockReset()
  })

  describe('GET /custom-mobile-compat/text-editor (page)', () => {
    it('renders the editor HTML when the token is valid', async () => {
      const realPath = join(workDir, 'notes.md')
      writeFileSync(realPath, '# Hello\n')
      getUserFile.mockResolvedValue({ id: 42, path: '/notes.md' })
      spaceEnv.mockResolvedValue(
        makeSpace(realPath, { dbFile: { id: 42, name: 'notes.md', path: '/personal', mime: 'text/markdown', size: 8 } as any })
      )
      const token = await directEditing.mintEditToken({ user: makeUser(), fileId: 42 })

      const r = makeRes()
      await controller.page(token, r.res)

      expect(r.headers['Content-Type']).toBe('text/html; charset=utf-8')
      expect(r.headers['Content-Security-Policy']).toContain("default-src 'self'")
      expect(typeof r.body).toBe('string')
      expect(r.body).toContain('<!doctype html>')
      // The page must embed the token so its inline script can call /content
      // and PUT back. Encoded for HTML safety.
      expect(r.body).toContain('data-token="')
      expect(r.body).toContain('notes.md')
    })

    it('renders an HTML error page (HTTP 200) when the token is invalid — never a JSON 4xx', async () => {
      // WKWebView drops the user into a useless blank screen on a non-2xx.
      // We surface friendly error text inline instead.
      const r = makeRes()
      await controller.page('garbage.token', r.res)

      expect(r.headers['Content-Type']).toBe('text/html; charset=utf-8')
      expect(r.body).toContain('Cannot open editor')
      expect(r.body).toContain('invalid or has expired')
    })

    it('renders an error page when the file does not belong to the token user', async () => {
      getUserFile.mockResolvedValue(null)
      const token = await directEditing.mintEditToken({ user: makeUser(), fileId: 999 })

      const r = makeRes()
      await controller.page(token, r.res)

      expect(r.body).toContain('Cannot open editor')
    })

    it('switches to read-only mode (with banner) when the file exceeds the size cap', async () => {
      const realPath = join(workDir, 'big.md')
      // Must be > 5 MB cap so getProps().size triggers the oversized branch.
      writeFileSync(realPath, Buffer.alloc(6 * 1024 * 1024))
      getUserFile.mockResolvedValue({ id: 42, path: '/big.md' })
      spaceEnv.mockResolvedValue(
        makeSpace(realPath, {
          dbFile: { id: 42, name: 'big.md', path: '/personal', mime: 'text/markdown', size: 10 * 1024 * 1024 } as any
        })
      )
      const token = await directEditing.mintEditToken({ user: makeUser(), fileId: 42 })

      const r = makeRes()
      await controller.page(token, r.res)

      expect(r.body).toContain('data-readonly="1"')
      expect(r.body).toContain('larger than')
    })

    it('renders the TipTap markdown page for .md files (not the CodeMirror page)', async () => {
      const realPath = join(workDir, 'README.md')
      writeFileSync(realPath, '# Hello')
      getUserFile.mockResolvedValue({ id: 42, path: '/README.md' })
      spaceEnv.mockResolvedValue(
        makeSpace(realPath, {
          relativeUrl: '/README.md',
          url: 'files/personal/README.md',
          dbFile: { id: 42, name: 'README.md', path: '/personal', mime: 'text/markdown', size: 7 } as any
        })
      )
      const token = await directEditing.mintEditToken({ user: makeUser(), fileId: 42 })

      const r = makeRes()
      await controller.page(token, r.res)

      // TipTap page loads tiptap.bundle.js; CodeMirror page loads
      // codemirror.bundle.js. Asserting on the bundle URL is the cheapest
      // discriminator — both pages share most of their HTML scaffolding.
      expect(r.body).toContain('tiptap.bundle.js')
      expect(r.body).not.toContain('codemirror.bundle.js')
    })

    it('renders the CodeMirror page for non-markdown text files (.js stays on CM)', async () => {
      const realPath = join(workDir, 'script.js')
      writeFileSync(realPath, 'console.log(1)\n')
      getUserFile.mockResolvedValue({ id: 42, path: '/script.js' })
      spaceEnv.mockResolvedValue(
        makeSpace(realPath, {
          relativeUrl: '/script.js',
          url: 'files/personal/script.js',
          dbFile: { id: 42, name: 'script.js', path: '/personal', mime: 'application/javascript', size: 14 } as any
        })
      )
      const token = await directEditing.mintEditToken({ user: makeUser(), fileId: 42 })

      const r = makeRes()
      await controller.page(token, r.res)

      expect(r.body).toContain('codemirror.bundle.js')
      expect(r.body).not.toContain('tiptap.bundle.js')
    })

    it('refuses to render the page for a non-editable mimetype (defense in depth)', async () => {
      const realPath = join(workDir, 'photo.jpg')
      writeFileSync(realPath, 'fake-jpeg')
      getUserFile.mockResolvedValue({ id: 42, path: '/photo.jpg' })
      spaceEnv.mockResolvedValue(
        makeSpace(realPath, { dbFile: { id: 42, name: 'photo.jpg', path: '/personal', mime: 'image-jpeg', size: 9 } as any })
      )
      const token = await directEditing.mintEditToken({ user: makeUser(), fileId: 42 })

      const r = makeRes()
      await controller.page(token, r.res)

      expect(r.body).toContain('cannot be edited as text')
    })
  })

  describe('GET /custom-mobile-compat/text-editor/content', () => {
    it('streams file bytes with a strong ETag', async () => {
      const realPath = join(workDir, 'notes2.md')
      writeFileSync(realPath, '# Notes\n')
      getUserFile.mockResolvedValue({ id: 42, path: '/notes2.md' })
      spaceEnv.mockResolvedValue(
        makeSpace(realPath, { dbFile: { id: 42, name: 'notes2.md', path: '/personal', mime: 'text-markdown', size: 9 } as any })
      )
      const token = await directEditing.mintEditToken({ user: makeUser(), fileId: 42 })

      const r = makeRes()
      await controller.getContent(token, r.res)

      expect(r.headers['Content-Type']).toBe('text/plain; charset=utf-8')
      expect(r.headers['Cache-Control']).toBe('no-store')
      // Strong ETag = no W/ prefix. Mobile clients break on weak ETags
      // (memory: NC mobile clients require strong ETag).
      // genEtag(..., weakPrefix=false) returns the raw `<sizeHex>-<mtimeHex>`
      // string without quotes — see files/utils/files.ts. Quotes are reserved
      // for the W/-prefixed weak form, which we explicitly avoid here.
      expect(r.headers['ETag']).toMatch(/^[a-f0-9]+-[a-f0-9]+$/)
      expect(r.headers['ETag']).not.toContain('W/')
    })

    it('returns 401 when the token is invalid', async () => {
      const r = makeRes()
      await expect(controller.getContent('not-a-token', r.res)).rejects.toMatchObject({ status: 401 })
    })

    it('returns 415 for files whose mime is not in the editor catalog', async () => {
      const realPath = join(workDir, 'photo2.jpg')
      writeFileSync(realPath, 'fake')
      getUserFile.mockResolvedValue({ id: 42, path: '/photo2.jpg' })
      spaceEnv.mockResolvedValue(
        makeSpace(realPath, { dbFile: { id: 42, name: 'photo2.jpg', path: '/personal', mime: 'image-jpeg', size: 4 } as any })
      )
      const token = await directEditing.mintEditToken({ user: makeUser(), fileId: 42 })

      const r = makeRes()
      await expect(controller.getContent(token, r.res)).rejects.toMatchObject({ status: 415 })
    })

    it('returns 413 for files larger than the editable cap', async () => {
      const realPath = join(workDir, 'big2.md')
      // 6 MB > 5 MB cap.
      writeFileSync(realPath, Buffer.alloc(6 * 1024 * 1024, 'a'))
      getUserFile.mockResolvedValue({ id: 42, path: '/big2.md' })
      spaceEnv.mockResolvedValue(
        makeSpace(realPath, { dbFile: { id: 42, name: 'big2.md', path: '/personal', mime: 'text/markdown', size: 6 * 1024 * 1024 } as any })
      )
      const token = await directEditing.mintEditToken({ user: makeUser(), fileId: 42 })

      const r = makeRes()
      await expect(controller.getContent(token, r.res)).rejects.toMatchObject({ status: 413 })
    })
  })

  describe('PUT /custom-mobile-compat/text-editor/content', () => {
    function makeReq(extraHeaders: Record<string, string> = {}): FastifyRequest {
      return {
        method: 'PUT',
        headers: { 'content-type': 'text/plain', 'content-length': '7', ...extraHeaders },
        raw: {
          /* would be a Readable in production */
        } as never
      } as unknown as FastifyRequest
    }

    it('delegates to FilesManager.saveStream and returns 204 with a fresh ETag', async () => {
      const realPath = join(workDir, 'put1.md')
      writeFileSync(realPath, '# v1\n')
      getUserFile.mockResolvedValue({ id: 42, path: '/put1.md' })
      spaceEnv.mockResolvedValue(
        makeSpace(realPath, { dbFile: { id: 42, name: 'put1.md', path: '/personal', mime: 'text-markdown', size: 5 } as any })
      )
      saveStream.mockImplementation(async () => {
        // Simulate the underlying write — mtime/size change so ETag updates.
        writeFileSync(realPath, 'NEW v2\n')
      })
      const token = await directEditing.mintEditToken({ user: makeUser(), fileId: 42 })

      const r = makeRes()
      await controller.putContent(makeReq(), token, r.res)

      expect(saveStream).toHaveBeenCalledTimes(1)
      expect(r.status).toBe(204)
      // genEtag(..., weakPrefix=false) returns the raw `<sizeHex>-<mtimeHex>`
      // string without quotes — see files/utils/files.ts. Quotes are reserved
      // for the W/-prefixed weak form, which we explicitly avoid here.
      expect(r.headers['ETag']).toMatch(/^[a-f0-9]+-[a-f0-9]+$/)
    })

    it('returns 412 when If-Match does not match the current ETag (mid-edit conflict)', async () => {
      const realPath = join(workDir, 'put2.md')
      writeFileSync(realPath, '# v1\n')
      getUserFile.mockResolvedValue({ id: 42, path: '/put2.md' })
      spaceEnv.mockResolvedValue(
        makeSpace(realPath, { dbFile: { id: 42, name: 'put2.md', path: '/personal', mime: 'text-markdown', size: 5 } as any })
      )
      const token = await directEditing.mintEditToken({ user: makeUser(), fileId: 42 })

      const r = makeRes()
      await expect(controller.putContent(makeReq({ 'if-match': '"stale-etag"' }), token, r.res)).rejects.toMatchObject({ status: 412 })
      expect(saveStream).not.toHaveBeenCalled()
    })

    it('accepts a save when If-Match matches the current ETag', async () => {
      const realPath = join(workDir, 'put3.md')
      writeFileSync(realPath, '# v1\n')
      getUserFile.mockResolvedValue({ id: 42, path: '/put3.md' })
      spaceEnv.mockResolvedValue(
        makeSpace(realPath, { dbFile: { id: 42, name: 'put3.md', path: '/personal', mime: 'text-markdown', size: 5 } as any })
      )
      saveStream.mockResolvedValue(true)
      const currentEtag = genEtag(null, realPath, false)
      const token = await directEditing.mintEditToken({ user: makeUser(), fileId: 42 })

      const r = makeRes()
      await controller.putContent(makeReq({ 'if-match': currentEtag }), token, r.res)

      expect(saveStream).toHaveBeenCalledTimes(1)
      expect(r.status).toBe(204)
    })

    it('rejects oversized writes via Content-Length without invoking saveStream', async () => {
      const realPath = join(workDir, 'put4.md')
      writeFileSync(realPath, '# v1\n')
      getUserFile.mockResolvedValue({ id: 42, path: '/put4.md' })
      spaceEnv.mockResolvedValue(
        makeSpace(realPath, { dbFile: { id: 42, name: 'put4.md', path: '/personal', mime: 'text-markdown', size: 5 } as any })
      )
      const token = await directEditing.mintEditToken({ user: makeUser(), fileId: 42 })

      const r = makeRes()
      await expect(controller.putContent(makeReq({ 'content-length': String(10 * 1024 * 1024) }), token, r.res)).rejects.toMatchObject({
        status: 413
      })
      expect(saveStream).not.toHaveBeenCalled()
    })

    it('returns 401 when the token is invalid', async () => {
      const r = makeRes()
      await expect(controller.putContent(makeReq(), 'invalid', r.res)).rejects.toMatchObject({ status: 401 })
    })

    it('rebuilds a UserModel from the token identity and forwards it to saveStream', async () => {
      // Defense: even though the editor endpoints are token-only, downstream
      // event-emit and lock-tracking rely on the user identity. Confirm the
      // identity carried in the token reaches saveStream as a UserModel.
      const realPath = join(workDir, 'put5.md')
      writeFileSync(realPath, 'hi')
      getUserFile.mockResolvedValue({ id: 42, path: '/put5.md' })
      spaceEnv.mockResolvedValue(
        makeSpace(realPath, { dbFile: { id: 42, name: 'put5.md', path: '/personal', mime: 'text-markdown', size: 2 } as any })
      )
      saveStream.mockResolvedValue(true)
      const token = await directEditing.mintEditToken({ user: makeUser({ id: 7, login: 'alice' }), fileId: 42 })

      await controller.putContent(makeReq(), token, makeRes().res)

      const userArg = saveStream.mock.calls[0][0]
      expect(userArg).toBeInstanceOf(UserModel)
      expect(userArg.id).toBe(7)
      expect(userArg.login).toBe('alice')
    })
  })

  describe('GET /custom-mobile-compat/text-editor/codemirror.bundle.js', () => {
    it('serves the committed bundle as JavaScript with a long cache window', async () => {
      // Bundle is generated by scripts/build-nc-text-editor.mjs and committed
      // to assets/codemirror.bundle.js. If it ever gets removed or the path
      // resolution breaks, the editor page silently falls back to <textarea> —
      // so this test is the canary that the bundle is wired correctly.
      const r = makeRes()
      await controller.bundle(r.res)
      expect(r.headers['Content-Type']).toBe('application/javascript; charset=utf-8')
      expect(r.headers['Cache-Control']).toContain('max-age=')
    })
  })

  describe('GET /custom-mobile-compat/text-editor/tiptap.bundle.js', () => {
    it('serves the committed TipTap bundle as JavaScript', async () => {
      // Same canary as the CodeMirror bundle test — if the asset disappears,
      // the markdown editor page degrades to <textarea> and the user loses the
      // WYSIWYG experience without any visible error.
      const r = makeRes()
      await controller.tiptapBundle(r.res)
      expect(r.headers['Content-Type']).toBe('application/javascript; charset=utf-8')
      expect(r.headers['Cache-Control']).toContain('max-age=')
    })
  })
})
