import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { FastifyReply, FastifyRequest } from 'fastify'
import { configuration } from '../../../configuration/config.environment'
import { acceptsJson, ocsEnvelope, type OcsEnvelope, type OcsOptions } from '../utils/ocs-envelope'

// Response helpers shared by the OCS controllers.
@Injectable()
export class NcResponseService {
  // Rejects the request if the caller asked for XML-only. Call this at the
  // top of each OCS handler. We could also return XML, but supporting a second
  // serialization buys nothing given every modern NC mobile client speaks JSON.
  requireJson(req: FastifyRequest): void {
    const accept = req.headers['accept']
    if (!acceptsJson(accept)) {
      throw new HttpException('OCS XML responses are not supported; send Accept: application/json', HttpStatus.NOT_ACCEPTABLE)
    }
  }

  // Set the Content-Type + OCS-APIRequest response header that NC mobile
  // clients expect and return the OCS-wrapped body.
  json<T>(res: FastifyReply, data: T, opts: OcsOptions = {}): OcsEnvelope<T> {
    res.header('Content-Type', 'application/json; charset=utf-8')
    return ocsEnvelope(data, opts)
  }

  // Compute the server's externally-visible base URL.
  // When OIDC is configured, the redirect URI's origin is authoritative — it is
  // admin-set and cannot be spoofed via request headers.  Fallback to request
  // headers only when OIDC is absent (password-only NC deployments), where the
  // header-based approach is acceptable because no OIDC redirect is involved.
  baseUrl(_req: FastifyRequest): string {
    const oidcRedirectUri = configuration.auth?.oidc?.redirectUri
    if (oidcRedirectUri) {
      return new URL(oidcRedirectUri).origin
    }
    // Non-OIDC fallback — proxy headers are trusted as before.
    const proto = (_req.headers['x-forwarded-proto'] as string | undefined) ?? (_req.protocol as string | undefined) ?? 'http'
    const host = (_req.headers['x-forwarded-host'] as string | undefined) ?? (_req.headers['host'] as string | undefined) ?? 'localhost'
    return `${proto}://${host}`
  }
}
