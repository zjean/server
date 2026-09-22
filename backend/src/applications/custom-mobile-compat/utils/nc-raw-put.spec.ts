import { FastifyInstance } from 'fastify'
import { bootstrapNcRawUploads, isNcRawBodyRequest } from './nc-raw-put'

describe(isNcRawBodyRequest.name, () => {
  it('matches a PUT anywhere under the NC remote prefix', () => {
    expect(isNcRawBodyRequest('PUT', '/remote.php/dav/files/jo/notes.txt')).toBe(true)
    expect(isNcRawBodyRequest('PUT', '/remote.php/dav/uploads/jo/upload-1/00000001')).toBe(true)
    expect(isNcRawBodyRequest('PUT', '/remote.php/webdav/notes.txt')).toBe(true)
  })

  it('ignores the query string when matching', () => {
    expect(isNcRawBodyRequest('PUT', '/remote.php/dav/files/jo/a.json?x=1')).toBe(true)
  })

  // The XML-bodied DAV methods must keep their parsed body — that is what
  // PROPFIND/PROPPATCH/REPORT handlers read.
  it.each(['PROPFIND', 'PROPPATCH', 'REPORT', 'MKCOL', 'MOVE', 'COPY', 'DELETE', 'GET', 'HEAD', 'POST'])('leaves %s alone', (method) => {
    expect(isNcRawBodyRequest(method, '/remote.php/dav/files/jo/notes.txt')).toBe(false)
  })

  it('leaves PUTs outside the NC tree alone', () => {
    // Upstream's own WebDAV tree has its own hook; the Sync client contract
    // and the v2 API both rely on parsed bodies for their PUTs.
    expect(isNcRawBodyRequest('PUT', '/webdav/personal/notes.txt')).toBe(false)
    expect(isNcRawBodyRequest('PUT', '/api/files/foo')).toBe(false)
    expect(isNcRawBodyRequest('PUT', '/custom-mobile-compat/text-editor/content')).toBe(false)
  })

  it('tolerates a missing method or url', () => {
    expect(isNcRawBodyRequest(undefined, '/remote.php/dav/files/jo/a.txt')).toBe(false)
    expect(isNcRawBodyRequest('PUT', undefined)).toBe(false)
  })
})

describe(bootstrapNcRawUploads.name, () => {
  // The hook is what makes the predicate load-bearing: registering it on
  // anything but onRequest would run it after the body parser has already
  // drained the stream.
  const register = () => {
    let hookName: string | undefined
    let hook: ((req: unknown, reply: unknown, done: () => void) => void) | undefined
    bootstrapNcRawUploads({
      addHook: (name: string, fn: never) => {
        hookName = name
        hook = fn
      }
    } as unknown as FastifyInstance)
    return { hookName, hook }
  }

  it('registers on onRequest', () => {
    expect(register().hookName).toBe('onRequest')
  })

  it('rewrites content-type on an NC PUT and leaves other requests untouched', () => {
    const { hook } = register()
    const put = { method: 'PUT', url: '/remote.php/dav/files/jo/a.json', headers: { 'content-type': 'application/json' } }
    hook(put, {}, () => undefined)
    expect(put.headers['content-type']).toBe('application/octet-stream')

    const propfind = { method: 'PROPFIND', url: '/remote.php/dav/files/jo', headers: { 'content-type': 'application/xml' } }
    hook(propfind, {}, () => undefined)
    expect(propfind.headers['content-type']).toBe('application/xml')
  })

  it('always calls done', () => {
    const { hook } = register()
    const done = vi.fn()
    hook({ method: 'GET', url: '/', headers: {} }, {}, done)
    expect(done).toHaveBeenCalledTimes(1)
  })
})
