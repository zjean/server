import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common'
import { FastifyReply, FastifyRequest } from 'fastify'
import { configuration } from '../../../configuration/config.environment'
import { acceptsJson, ocsEnvelope, type OcsEnvelope, type OcsOptions } from '../utils/ocs-envelope'

// Response helpers shared by the OCS controllers.
@Injectable()
export class NcResponseService {
  // Audit U3 instrumentation. requireJson() is the single chokepoint where an
  // `Accept: application/xml` request earns a 406 from any OCS handler — we
  // log the URL + Accept header so a device session can reveal which (if any)
  // endpoints stock NextcloudKit hits with XML-only. Remove once U3 is
  // resolved.
  private readonly logger = new Logger(NcResponseService.name)

  // Rejects the request if the caller asked for XML-only. Call this at the
  // top of each OCS handler. We could also return XML, but supporting a second
  // serialization buys nothing given every modern NC mobile client speaks JSON.
  requireJson(req: FastifyRequest): void {
    const accept = req.headers['accept']
    if (!acceptsJson(accept)) {
      this.logger.warn({
        tag: 'requireJson',
        msg: `406 — Accept=${Array.isArray(accept) ? accept.join(', ') : (accept ?? '-')} url=${req.url ?? '-'} ua=${req.headers['user-agent'] ?? '-'}`
      })
      throw new HttpException('OCS XML responses are not supported; send Accept: application/json', HttpStatus.NOT_ACCEPTABLE)
    }
  }

  // Set the Content-Type + OCS-APIRequest response header that NC mobile
  // clients expect and return the OCS-wrapped body.
  json<T>(res: FastifyReply, data: T, opts: OcsOptions = {}): OcsEnvelope<T> {
    res.header('Content-Type', 'application/json; charset=utf-8')
    return ocsEnvelope(data, opts)
  }

  // Compute the server's externally-visible mobile-facing base URL — the
  // origin Sync-in advertises in capabilities, login-v2, directEditing.url,
  // and the OIDC handoff's `server` field.
  //
  // Resolution order (first wins):
  //   1. `x-forwarded-proto` + `x-forwarded-host` — proxy says where clients
  //      connect. Authoritative when set, since the proxy is the deployment's
  //      source of truth for externally-visible URLs.
  //   2. `auth.oidc.redirectUri` origin — admin-set, non-spoofable. Used as
  //      a safety net for OIDC-enabled deployments where the proxy hasn't
  //      forwarded headers (or can't be trusted to). For deployments where
  //      the OIDC redirect host and the mobile-facing host genuinely differ,
  //      `x-forwarded-host` MUST be set correctly — same requirement as the
  //      rest of Sync-in.
  //   3. `host` request header.
  //   4. `'localhost'`.
  //
  // The OIDC *callback* URL is unrelated to this method — callback
  // construction reads `auth.oidc.redirectUri` directly in
  // NcMobileOidcController. Earlier versions of `baseUrl()` returned the
  // OIDC origin unconditionally, which silently overrode correctly-set
  // proxy headers and broke deployments where the OIDC and mobile hosts
  // differ.
  baseUrl(req: FastifyRequest): string {
    const fwdProto = req.headers['x-forwarded-proto'] as string | undefined
    const fwdHost = req.headers['x-forwarded-host'] as string | undefined
    if (fwdHost) {
      return `${fwdProto ?? 'http'}://${fwdHost}`
    }
    const oidcRedirectUri = configuration.auth?.oidc?.redirectUri
    if (oidcRedirectUri) {
      return new URL(oidcRedirectUri).origin
    }
    const proto = fwdProto ?? (req.protocol as string | undefined) ?? 'http'
    const host = (req.headers['host'] as string | undefined) ?? 'localhost'
    return `${proto}://${host}`
  }
}
