import Fastify, { FastifyInstance, FastifyRequest } from 'fastify'
import { Readable } from 'node:stream'
import { isLoginFlowRoute, parseUrlencoded, readUrlencodedBody, registerUrlencodedParser, URLENCODED_MAX_BYTES } from './nc-urlencoded-body'

describe(isLoginFlowRoute.name, () => {
  it.each([
    '/index.php/login/v2',
    '/index.php/login/v2/poll',
    '/login/v2/poll',
    '/login/v2/flow/abc123',
    '/login/v2/grant/abc123',
    // ignoreTrailingSlash is on, so both spellings reach the same handler.
    '/login/v2/poll/'
  ])('accepts %s', (url) => {
    expect(isLoginFlowRoute(url)).toBe(true)
  })

  it('ignores the query string', () => {
    expect(isLoginFlowRoute('/login/v2/poll?token=x')).toBe(true)
  })

  // Everything below must keep req.raw readable: these are the routes the
  // `parseAs: 'string'` registration was silently draining.
  it.each([
    '/remote.php/dav/files/jo/notes.txt',
    '/remote.php/dav/uploads/jo/upload-1/00000001',
    '/webdav/personal/notes.txt',
    '/api/files/foo',
    '/',
    '/loginv2/poll',
    // Neither prefix matches: the canonical short form has no trailing slash
    // and is a GET-less route nothing posts to.
    '/login/v2'
  ])('rejects %s', (url) => {
    expect(isLoginFlowRoute(url)).toBe(false)
  })

  it('tolerates a missing url', () => {
    expect(isLoginFlowRoute(undefined)).toBe(false)
  })
})

describe(parseUrlencoded.name, () => {
  it('parses flat pairs, decoding + as space', () => {
    expect(parseUrlencoded('login=jo+doe&password=s%3Acret')).toEqual({ login: 'jo doe', password: 's:cret' })
  })

  it('gives a valueless key the empty string and skips empty pairs', () => {
    expect(parseUrlencoded('a&&b=')).toEqual({ a: '', b: '' })
  })

  it('takes the last value when a key repeats', () => {
    expect(parseUrlencoded('token=one&token=two')).toEqual({ token: 'two' })
  })

  it('throws on malformed percent-encoding rather than returning a half-decoded value', () => {
    expect(() => parseUrlencoded('token=%E0%A4%A')).toThrow()
  })
})

describe(readUrlencodedBody.name, () => {
  const read = (chunks: string[], maxBytes = URLENCODED_MAX_BYTES) =>
    new Promise<{ err: Error | null; body?: Record<string, string> }>((resolve) => {
      readUrlencodedBody(Readable.from(chunks), maxBytes, (err, body) => resolve({ err, body }))
    })

  it('collects a body split across chunks', async () => {
    const { err, body } = await read(['tok', 'en=abc', '123'])
    expect(err).toBeNull()
    expect(body).toEqual({ token: 'abc123' })
  })

  it('parses an empty body to an empty object', async () => {
    const { err, body } = await read([])
    expect(err).toBeNull()
    expect(body).toEqual({})
  })

  // THE POINT OF THE FIX: the parser must have a bound of its own. Without one
  // it inherits the server's 25 MB, which is what let an unauthenticated
  // client make the server buffer 25 MB into a string on any URL.
  it('refuses a body over the cap with a 413 instead of buffering it', async () => {
    const { err, body } = await read([`token=${'x'.repeat(64)}`], 16)
    expect(body).toBeUndefined()
    expect(err).toMatchObject({ statusCode: 413, code: 'FST_ERR_CTP_BODY_TOO_LARGE' })
  })

  it('caps on the cumulative size, not on a single chunk', async () => {
    const { err } = await read(['a=1&', 'b=2&', 'c=3&', 'd=4'], 8)
    expect(err).toMatchObject({ statusCode: 413 })
  })

  it('turns malformed percent-encoding into a 400', async () => {
    const { err } = await read(['token=%E0%A4%A'])
    expect(err).toMatchObject({ statusCode: 400 })
  })

  it('reports a stream error once and only once', async () => {
    const boom = new Error('socket reset')
    const payload = new Readable({
      read() {
        this.destroy(boom)
      }
    })
    const calls: (Error | null)[] = []
    await new Promise<void>((resolve) => {
      readUrlencodedBody(payload, URLENCODED_MAX_BYTES, (err) => {
        calls.push(err)
        resolve()
      })
      setTimeout(resolve, 50)
    })
    expect(calls).toEqual([boom])
  })

  it('detaches its listeners once settled, so a late event cannot call done twice', async () => {
    const payload = Readable.from(['token=abc'])
    const calls: unknown[] = []
    await new Promise<void>((resolve) => {
      readUrlencodedBody(payload, URLENCODED_MAX_BYTES, (...args) => {
        calls.push(args)
        resolve()
      })
    })
    // Our handler is gone, so nothing is left to hear these — an unhandled
    // 'error' emit throwing is itself the proof that the listener was removed.
    payload.on('error', () => undefined)
    payload.emit('error', new Error('late'))
    payload.emit('end')
    expect(calls).toHaveLength(1)
  })
})

// The defect this guards against is not in any function above — it is in WHEN
// fastify runs the parser relative to the stream. Only a real fastify instance
// can show it, so this drives one built the way app.bootstrap.ts builds it.
describe(registerUrlencodedParser.name, () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = Fastify({ bodyLimit: 26214400 })
    // The '*' catch-all app.bootstrap.ts registers first: unknown types stay on
    // req.raw. The urlencoded parser must behave identically off the login
    // routes.
    app.addContentTypeParser('*', (_req: FastifyRequest, _payload: FastifyRequest['raw'], done) => done(null))
    registerUrlencodedParser(app)
    // Counts what is still readable from req.raw by the time the handler runs —
    // which is exactly what every DAV write path does.
    app.post('/*', async (req) => {
      let bytes = 0
      for await (const chunk of req.raw) bytes += (chunk as Buffer).length
      return { bytes, body: req.body ?? null }
    })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  const post = (url: string, payload: string) =>
    app.inject({ method: 'POST', url, payload, headers: { 'content-type': 'application/x-www-form-urlencoded' } })

  it.each(['/remote.php/dav/uploads/jo/up-1/00000001', '/webdav/personal/a.txt', '/api/anything'])('leaves req.raw readable on %s', async (url) => {
    const payload = 'a=1&b=2&this-is-file-content'
    const res = await post(url, payload)
    expect(res.statusCode).toBe(200)
    // THE ASSERTION: with `parseAs: 'string'` this reads 0 — the body was
    // already drained into a string the handler never sees.
    expect(res.json()).toEqual({ bytes: Buffer.byteLength(payload), body: null })
  })

  it('parses the body on a login-v2 route', async () => {
    const res = await post('/login/v2/poll', 'token=abc123')
    expect(res.json()).toEqual({ bytes: 0, body: { token: 'abc123' } })
  })

  it('caps a login-v2 body well under the server bodyLimit', async () => {
    const res = await post('/login/v2/poll', `token=${'x'.repeat(URLENCODED_MAX_BYTES)}`)
    expect(res.statusCode).toBe(413)
  })
})
