import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JwtModule } from '@nestjs/jwt'
import { Test, type TestingModule } from '@nestjs/testing'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { HttpStatus } from '@nestjs/common'
import { FileError } from '../../files/models/file-error'
import { LockConflict } from '../../files/models/file-lock-error'
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
    // `body` mirrors what fastify's text/plain parser leaves on the request:
    // a string. Anything else is a different content type — see the 415 cases.
    // Wrapped rather than a default parameter, because `undefined` is itself
    // one of the bodies under test (app.bootstrap's catch-all `*` parser) and
    // an explicit `undefined` argument would re-trigger the default.
    function makeReq(extraHeaders: Record<string, string> = {}, bodyOverride?: { value: unknown }): FastifyRequest {
      return {
        method: 'PUT',
        headers: { 'content-type': 'text/plain', 'content-length': '7', ...extraHeaders },
        body: bodyOverride ? bodyOverride.value : 'NEW v2\n',
        raw: { headers: { 'content-type': 'text/plain' }, method: 'PUT' } as never
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

    // Fork (#503 review): the catch-all used to flatten EVERY saveStream
    // failure to 500, including the deliberate FileError refusals — the
    // #518 short-write 400, quota/max-size, "parent must exists". The other
    // two saveStream callers translate FileError to its own httpCode
    // (WebDAVMethods.handleError, FilesMethods.handleError); this one has to
    // agree or a client gets a server error it cannot act on.
    it.each([
      ['a short-write refusal', new FileError(HttpStatus.BAD_REQUEST, 'Incomplete upload: received 0 of 7 declared bytes'), 400],
      ['a quota refusal', new FileError(HttpStatus.INSUFFICIENT_STORAGE, 'quota exceeded'), 507],
      ['a conflict', new FileError(HttpStatus.CONFLICT, 'Parent must exists'), 409]
    ])('maps %s to its own status instead of 500', async (_label, thrown, expected) => {
      const realPath = join(workDir, 'put-err.md')
      writeFileSync(realPath, '# v1\n')
      getUserFile.mockResolvedValue({ id: 42, path: '/put-err.md' })
      spaceEnv.mockResolvedValue(
        makeSpace(realPath, { dbFile: { id: 42, name: 'put-err.md', path: '/personal', mime: 'text-markdown', size: 5 } as any })
      )
      saveStream.mockRejectedValue(thrown)
      const token = await directEditing.mintEditToken({ user: makeUser(), fileId: 42 })

      await expect(controller.putContent(makeReq(), token, makeRes().res)).rejects.toMatchObject({
        status: expected,
        message: thrown.message
      })
    })

    it('maps a LockConflict to 423 instead of 500', async () => {
      const realPath = join(workDir, 'put-lock.md')
      writeFileSync(realPath, '# v1\n')
      getUserFile.mockResolvedValue({ id: 42, path: '/put-lock.md' })
      spaceEnv.mockResolvedValue(
        makeSpace(realPath, { dbFile: { id: 42, name: 'put-lock.md', path: '/personal', mime: 'text-markdown', size: 5 } as any })
      )
      saveStream.mockRejectedValue(new LockConflict({ key: 'lock-1' } as any, 'Conflicting lock'))
      const token = await directEditing.mintEditToken({ user: makeUser(), fileId: 42 })

      await expect(controller.putContent(makeReq(), token, makeRes().res)).rejects.toMatchObject({ status: 423 })
    })

    it('still returns 500 for an unexpected error', async () => {
      const realPath = join(workDir, 'put-boom.md')
      writeFileSync(realPath, '# v1\n')
      getUserFile.mockResolvedValue({ id: 42, path: '/put-boom.md' })
      spaceEnv.mockResolvedValue(
        makeSpace(realPath, { dbFile: { id: 42, name: 'put-boom.md', path: '/personal', mime: 'text-markdown', size: 5 } as any })
      )
      saveStream.mockRejectedValue(new Error('disk on fire'))
      const token = await directEditing.mintEditToken({ user: makeUser(), fileId: 42 })

      await expect(controller.putContent(makeReq(), token, makeRes().res)).rejects.toMatchObject({ status: 500 })
    })

    // Fork (#503 review): the body re-encode assumed fastify's text/plain
    // parser had run. For any other content type req.body is NOT a string
    // (an object for JSON, undefined under app.bootstrap's catch-all `*`
    // parser — text/markdown, application/octet-stream, multipart), and the
    // old `: ''` default truncated the file to 0 bytes and answered 204 with
    // a fresh ETag. The #518 assertion could not catch it either: the
    // content-length re-derivation recomputes the declaration from the same
    // empty buffer, so 0 >= 0 passes.
    it.each([
      ['a parsed JSON object', { text: 'hello' }],
      ['an undefined body from the catch-all parser', undefined],
      ['a raw Buffer', Buffer.from('hello')]
    ])('refuses %s with 415 and does not touch the file', async (_label, body) => {
      const realPath = join(workDir, `put-415-${_label.replace(/\W+/g, '-')}.md`)
      const original = '# keep me\n'
      writeFileSync(realPath, original)
      getUserFile.mockResolvedValue({ id: 42, path: '/put-415.md' })
      spaceEnv.mockResolvedValue(
        makeSpace(realPath, { dbFile: { id: 42, name: 'put-415.md', path: '/personal', mime: 'text-markdown', size: 5 } as any })
      )
      const token = await directEditing.mintEditToken({ user: makeUser(), fileId: 42 })

      await expect(controller.putContent(makeReq({ 'content-type': 'text/markdown' }, { value: body }), token, makeRes().res)).rejects.toMatchObject({
        status: 415
      })

      expect(saveStream).not.toHaveBeenCalled()
      // The refusal is only worth anything if the file survived it — a 415
      // over an emptied file would be the same defect wearing a 4xx.
      expect(readFileSync(realPath, 'utf-8')).toBe(original)
    })

    it('accepts an empty string body (a deliberate save of an empty file)', async () => {
      // '' is a legitimate save, not a missing body — the guard is on the
      // TYPE, not on emptiness.
      const realPath = join(workDir, 'put-empty.md')
      writeFileSync(realPath, '# v1\n')
      getUserFile.mockResolvedValue({ id: 42, path: '/put-empty.md' })
      spaceEnv.mockResolvedValue(
        makeSpace(realPath, { dbFile: { id: 42, name: 'put-empty.md', path: '/personal', mime: 'text-markdown', size: 5 } as any })
      )
      saveStream.mockResolvedValue(true)
      const token = await directEditing.mintEditToken({ user: makeUser(), fileId: 42 })

      const r = makeRes()
      await controller.putContent(makeReq({ 'content-length': '0' }, { value: '' }), token, r.res)

      expect(saveStream).toHaveBeenCalledTimes(1)
      expect(r.status).toBe(204)
    })

    it('re-derives content-length from the re-encoded body', async () => {
      // The header the client sent counts wire bytes; saveStream now reads
      // our re-encode of fastify's parse of them, and #518 asserts the two
      // agree. A multi-byte character is where a forwarded header would 400.
      const realPath = join(workDir, 'put-utf8.md')
      writeFileSync(realPath, '# v1\n')
      getUserFile.mockResolvedValue({ id: 42, path: '/put-utf8.md' })
      spaceEnv.mockResolvedValue(
        makeSpace(realPath, { dbFile: { id: 42, name: 'put-utf8.md', path: '/personal', mime: 'text-markdown', size: 5 } as any })
      )
      saveStream.mockResolvedValue(true)
      const token = await directEditing.mintEditToken({ user: makeUser(), fileId: 42 })

      const req = makeReq({ 'content-length': '999' }, { value: 'héllo' })
      await controller.putContent(req, token, makeRes().res)

      const forwarded = saveStream.mock.calls[0][2] as FastifyRequest
      expect(forwarded.raw.headers['content-length']).toBe(String(Buffer.byteLength('héllo', 'utf-8')))
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
