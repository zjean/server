import { NestFastifyApplication } from '@nestjs/platform-fastify'
import fs from 'node:fs/promises'
import { appBootstrap } from '../../../app.bootstrap'
import { USER_PERMISSION, USER_PERMS_SEP, USER_ROLE } from '../../users/constants/user'
import { UserModel } from '../../users/models/user.model'
import { AdminUsersManager } from '../../users/services/admin-users-manager.service'
import { generateUserTest } from '../../users/utils/test'
import { NcAppPasswordService } from '../services/nc-app-password.service'

// Body draining on the NC-compat surface, driven over real HTTP.
//
// WHY THIS EXISTS. Fastify picks a body parser from Content-Type, and a
// BUFFERED parser reads req.raw to EOF before the route handler runs. Every NC
// write path downstream (WebDAVMethods.put → FilesManager.saveStream, and
// NcUploadsController's chunk writer) pipes req.raw — so a drained stream
// yields zero bytes, and the plain-PUT path answers 201 while writing nothing.
// Silent data loss on an ordinary upload.
//
// The content types that could do it are not exotic: application/json and
// text/plain are fastify DEFAULTS, application/xml and text/xml are registered
// by webdav/utils/bootstrap.ts for PROPFIND, and this fork registers a parser
// for application/x-www-form-urlencoded to serve the login-v2 poll. NC Android
// sends the file's own mime verbatim on a plain PUT
// (UploadFileRemoteOperation → FileRequestEntity.getContentType), so a small
// .txt really does arrive as text/plain.
//
// Nothing about this is provable from a unit spec: the defect lives in the
// order fastify runs the parser relative to the handler, which only a real
// request exercises. Hence e2e, and hence the assertions are on the BYTES ON
// DISK rather than on the status code — the 201 is exactly what made the
// original bug silent.
describe('NC DAV request bodies are never drained by a content-type parser (e2e)', () => {
  let app: NestFastifyApplication
  let admin: AdminUsersManager
  let user: UserModel
  // NcBasicAuthGuard accepts ONLY a MOBILE_NC-scoped app password and
  // deliberately refuses the main login password.
  let ncAuth: string

  beforeAll(async () => {
    app = await appBootstrap()
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    admin = app.get(AdminUsersManager)
    // `permissions` is the column; `applications` is derived from it and is not
    // one — a user built straight from generateUserTest() 403s on every request.
    user = await admin.createUserOrGuest(
      { ...generateUserTest(false), permissions: Object.values(USER_PERMISSION).join(USER_PERMS_SEP) } as never,
      USER_ROLE.USER
    )
    const minted = await app.get(NcAppPasswordService).mintMobileAppPassword(user, 'nc-put-body-e2e')
    ncAuth = `Basic ${Buffer.from(`${user.login}:${minted.password}`).toString('base64')}`
  })

  afterAll(async () => {
    if (user?.id) {
      await admin.deleteUserOrGuest(user.id, user.login, { deleteSpace: true, isGuest: false } as never).catch(() => undefined)
    }
    await app?.close()
  })

  const nc = (method: string, url: string, opts: { payload?: string; headers?: Record<string, string> } = {}) =>
    app.inject({
      method,
      url,
      headers: { authorization: ncAuth, ...(opts.headers ?? {}) },
      ...(opts.payload === undefined ? {} : { payload: opts.payload })
    } as never)

  describe('plain PUT to /remote.php/dav/files', () => {
    // Every content type with a registered parser, plus one that has none, so a
    // future parser registration is caught here rather than in the field.
    const contentTypes = [
      'text/plain',
      'text/plain; charset=utf-8',
      'application/json',
      'application/xml',
      'text/xml',
      'application/x-www-form-urlencoded',
      'application/octet-stream',
      // NC Android hands through whatever the platform resolved for the
      // extension; an unmapped one arrives like this.
      'application/vnd.oasis.opendocument.text'
    ]

    it.each(contentTypes)('writes the whole body when Content-Type is %s', async (contentType) => {
      const rel = `nc-put-${contentType.replace(/[^a-z0-9]/gi, '-')}.bin`
      const target = `${UserModel.getFilesPath(user.login)}/${rel}`
      // Deliberately parseable as each of the buffered formats' happy path, so
      // a parser that DOES run cannot fail loudly and mask the drain.
      const payload = '{"key":"value","n":42}'

      try {
        const put = await nc('PUT', `/remote.php/dav/files/${user.login}/${rel}`, { payload, headers: { 'content-type': contentType } })
        expect([200, 201, 204]).toContain(put.statusCode)
        // THE ASSERTION: a drained stream answers 201 and writes 0 bytes.
        expect(await fs.readFile(target, 'utf8')).toBe(payload)
      } finally {
        await fs.rm(target, { force: true }).catch(() => undefined)
      }
    })
  })

  describe('chunk PUT to /remote.php/dav/uploads', () => {
    // The chunked path fails LOUDLY instead of silently — chunkHandler compares
    // the bytes it wrote to Content-Length and 400s — so before the fix a
    // text-content-type chunk upload retry-looped rather than corrupting. Same
    // root cause, different symptom; pin both.
    it.each(['text/plain', 'application/json', 'application/xml', 'application/x-www-form-urlencoded'])(
      'accepts a chunk whose Content-Type is %s and assembles it intact',
      async (contentType) => {
        const rel = `nc-chunk-${contentType.replace(/[^a-z0-9]/gi, '-')}.bin`
        const uploadId = `e2e-body-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const uploadRoot = `/remote.php/dav/uploads/${user.login}/${uploadId}`
        const target = `${UserModel.getFilesPath(user.login)}/${rel}`
        const payload = 'chunk-payload-that-parses-as-nothing-in-particular'

        try {
          expect((await nc('MKCOL', uploadRoot)).statusCode).toBe(201)
          const chunk = await nc('PUT', `${uploadRoot}/00000001`, { payload, headers: { 'content-type': contentType } })
          expect([200, 201, 204]).toContain(chunk.statusCode)

          const move = await nc('MOVE', `${uploadRoot}/.file`, {
            headers: { destination: `/remote.php/dav/files/${user.login}/${rel}`, 'oc-total-length': String(Buffer.byteLength(payload)) }
          })
          expect([201, 204]).toContain(move.statusCode)
          expect(await fs.readFile(target, 'utf8')).toBe(payload)
        } finally {
          await fs.rm(target, { force: true }).catch(() => undefined)
        }
      }
    )
  })

  describe('the login-v2 form parser', () => {
    const form = (url: string, payload: string) =>
      app.inject({ method: 'POST', url, payload, headers: { 'content-type': 'application/x-www-form-urlencoded' } } as never)

    // The counterweight to narrowing the parser: these routes are its only
    // consumers and they must still get a parsed body. `readPollToken` answers
    // 400 'missing token' when the body is absent and 404 + '[]' when it read a
    // token that no flow matches — so the STATUS is the differential.
    it.each(['/login/v2/poll', '/index.php/login/v2/poll'])('still reads token= from a form body at %s', async (url) => {
      const res = await form(url, `token=${'0'.repeat(32)}`)
      expect(res.statusCode).toBe(404)
      expect(res.body).toBe('[]')
    })

    it('answers 400 when the form body really is empty', async () => {
      expect((await form('/login/v2/poll', '')).statusCode).toBe(400)
    })

    // A parser registered without its own bodyLimit inherits the server's
    // 25 MB. This is the cap that replaces it.
    it('refuses an oversized form body instead of buffering it', async () => {
      const res = await form('/login/v2/poll', `token=${'x'.repeat(9000)}`)
      expect(res.statusCode).toBe(413)
    })
  })

  describe('the XML-bodied DAV methods keep their parsed body', () => {
    // The counterweight: the fix must not reach any method other than PUT, or
    // every PROPFIND in the tree loses the body its handler reads.
    it('still answers a PROPFIND with a multistatus', async () => {
      const res = await nc('PROPFIND', `/remote.php/dav/files/${user.login}`, {
        headers: { 'content-type': 'application/xml', depth: '0' },
        payload: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/></d:prop></d:propfind>'
      })
      expect(res.statusCode).toBe(207)
      expect(res.body).toContain('d:multistatus')
    })
  })
})
