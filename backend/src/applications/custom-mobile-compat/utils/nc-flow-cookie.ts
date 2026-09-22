import type { FastifyReply, FastifyRequest } from 'fastify'

// Browser-binding cookie for the NC Login Flow v2 browser hop.
//
// The flow's login token travels in a URL, which means it can be forwarded,
// pasted or planted. The cookie is what ties the browser steps of ONE flow to
// ONE browser: it is set when the flow page is first opened and checked on
// every step that follows (OIDC start, OIDC callback, credential POST, grant
// POST). Upstream Nextcloud gets the same property from its server-side
// session; this fork's NC surface is deliberately session-less, so the binding
// is an explicit cookie instead.
//
// Not a credential in its own right — it carries no identity and grants
// nothing. It only answers "is this the same browser as before?".
export const NC_FLOW_COOKIE = 'nc_login_flow'

// Matches the flow TTL in NcLoginFlowService (20 min). A shorter cookie would
// strand a slow IdP round-trip; a longer one would outlive the thing it binds.
const MAX_AGE_SECONDS = 20 * 60

export function readFlowCookie(req: FastifyRequest): string | undefined {
  const fromPlugin = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies?.[NC_FLOW_COOKIE]
  if (fromPlugin) return fromPlugin
  // Fall back to parsing the header directly. @fastify/cookie is registered in
  // app.bootstrap, but unit tests construct requests without it and a missing
  // decorator should read as "no cookie", never as a crash.
  const raw = req.headers?.cookie
  if (!raw) return undefined
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === NC_FLOW_COOKIE) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

export function setFlowCookie(req: FastifyRequest, res: FastifyReply, value: string): void {
  const options = {
    httpOnly: true,
    // Lax, not Strict: the OIDC round-trip returns via a top-level cross-site
    // redirect from the identity provider, and Strict would withhold the
    // cookie on exactly that navigation — breaking the binding it exists for.
    // Lax still withholds it from cross-site POSTs, which is the CSRF case
    // that matters for the grant.
    sameSite: 'lax' as const,
    secure: isHttps(req),
    path: '/',
    maxAge: MAX_AGE_SECONDS
  }
  const withPlugin = res as FastifyReply & { setCookie?: (n: string, v: string, o: typeof options) => unknown }
  if (typeof withPlugin.setCookie === 'function') {
    withPlugin.setCookie(NC_FLOW_COOKIE, value, options)
    return
  }
  res.header('set-cookie', serialiseCookie(NC_FLOW_COOKIE, value, options))
}

function isHttps(req: FastifyRequest): boolean {
  const proto = req.headers?.['x-forwarded-proto']
  const first = Array.isArray(proto) ? proto[0] : proto
  if (first) return first.split(',')[0].trim() === 'https'
  return (req as FastifyRequest & { protocol?: string }).protocol === 'https'
}

function serialiseCookie(
  name: string,
  value: string,
  o: { httpOnly: boolean; sameSite: string; secure: boolean; path: string; maxAge: number }
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${o.path}`,
    `Max-Age=${o.maxAge}`,
    `SameSite=${o.sameSite === 'lax' ? 'Lax' : o.sameSite}`
  ]
  if (o.httpOnly) parts.push('HttpOnly')
  if (o.secure) parts.push('Secure')
  return parts.join('; ')
}
