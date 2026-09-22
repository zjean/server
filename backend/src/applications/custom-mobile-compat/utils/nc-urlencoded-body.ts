import { HttpStatus } from '@nestjs/common'
import { FastifyInstance, FastifyRequest } from 'fastify'
import { NC_ROUTE } from '../constants/routes'

// A login-v2 poll body is `token=<32 hex>` — about 40 bytes. The two browser
// forms carry a login, a password and a grant token. 8 KiB is already an order
// of magnitude more than any of them can legitimately need, and it is the only
// bound on this path: fastify applies `bodyLimit` per PARSER, and a parser
// registered without one inherits the server-wide 25 MB.
export const URLENCODED_MAX_BYTES = 8192

export type UrlencodedDone = (err: Error | null, body?: Record<string, string>) => void

/**
 * Is this one of the NC login-v2 routes that actually reads a form body?
 *
 * Those are the ONLY consumers of application/x-www-form-urlencoded in the
 * whole server (grepped: three `method="post"` forms, all under /login/v2/,
 * plus the poll endpoint NC clients POST `token=…` to). Everything else must
 * keep req.raw readable as a stream.
 */
export function isLoginFlowRoute(url: string | undefined): boolean {
  const urlPath = (url ?? '').split('?')[0]
  // '/index.php/login/v2' covers the initiate call and the '/poll' suffix the
  // docs advertise; '/login/v2/' covers the flow page, the grant POST and the
  // alternate poll path some client versions use instead.
  return urlPath.startsWith(NC_ROUTE.LOGIN_V2) || urlPath.startsWith('/login/v2/') || urlPath === NC_ROUTE.LOGIN_V2_POLL_ALT
}

/**
 * Parse a form body. Flat keys only — no nested keys, no array syntax, last
 * value wins. Throws on malformed percent-encoding, which the caller turns
 * into a 400 rather than letting a half-decoded token through.
 */
export function parseUrlencoded(raw: string): Record<string, string> {
  const parsed: Record<string, string> = {}
  for (const pair of raw.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const key = decodeURIComponent((eq >= 0 ? pair.slice(0, eq) : pair).replace(/\+/g, ' '))
    parsed[key] = eq >= 0 ? decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' ')) : ''
  }
  return parsed
}

/**
 * Collect and parse a form body under an explicit cap.
 *
 * This exists because `{ parseAs: 'string' }` cannot be used here. Fastify
 * runs `rawBody()` BEFORE the parser function when `asString` is set
 * (lib/content-type-parser.js `run()`), so a URL check inside the function
 * happens after the stream is already at EOF — which drained and buffered
 * every urlencoded body on every route, pre-guard, up to the server-wide
 * 25 MB, and then threw it away. It also turned any DAV write arriving with
 * this content type into a 0-byte file (the sibling failure, #475).
 *
 * Reading the stream here instead lets the caller branch on the URL first and
 * leave req.raw untouched everywhere else.
 */
export function readUrlencodedBody(payload: NodeJS.ReadableStream, maxBytes: number, done: UrlencodedDone): void {
  const chunks: Buffer[] = []
  let received = 0
  let settled = false

  const finish = (err: Error | null, body?: Record<string, string>): void => {
    if (settled) return
    settled = true
    payload.removeListener('data', onData)
    payload.removeListener('end', onEnd)
    payload.removeListener('error', onError)
    done(err, body)
  }

  function onData(chunk: Buffer | string): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    received += buf.length
    if (received > maxBytes) {
      finish(bodyTooLarge(maxBytes))
      return
    }
    chunks.push(buf)
  }

  function onEnd(): void {
    try {
      finish(null, parseUrlencoded(Buffer.concat(chunks).toString('utf8')))
    } catch (err) {
      finish(badRequest((err as Error).message))
    }
  }

  function onError(err: Error): void {
    finish(err)
  }

  payload.on('data', onData)
  payload.on('end', onEnd)
  payload.on('error', onError)
  payload.resume()
}

/**
 * Register the application/x-www-form-urlencoded parser.
 *
 * Registered WITHOUT `parseAs`, deliberately — see readUrlencodedBody. The URL
 * check has to happen while the stream is still unread, which only a plain
 * parser allows, and non-login routes then get exactly the `done(null)`
 * passthrough fastify's '*' catch-all gives everything else.
 */
export function registerUrlencodedParser(fastifyInstance: FastifyInstance): void {
  fastifyInstance.addContentTypeParser(
    'application/x-www-form-urlencoded',
    (req: FastifyRequest, payload: FastifyRequest['raw'], done: UrlencodedDone) => {
      if (!isLoginFlowRoute(req.url)) {
        return done(null)
      }
      readUrlencodedBody(payload, URLENCODED_MAX_BYTES, done)
    }
  )
}

function bodyTooLarge(maxBytes: number): Error {
  // fastify replies with `statusCode` when a content-type parser calls back
  // with an error; `code` matches what its own rawBody() would have raised so
  // log greps keep working.
  return Object.assign(new Error(`form body exceeds ${maxBytes} bytes`), {
    statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
    code: 'FST_ERR_CTP_BODY_TOO_LARGE'
  })
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: HttpStatus.BAD_REQUEST })
}
