import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { FastifyReply, FastifyRequest } from 'fastify'
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

  // Compute the server's externally-visible mobile-facing base URL — the
  // origin Sync-in advertises in capabilities, login-v2, directEditing.url,
  // and the OIDC handoff's `server` field.
  //
  // Derived from `x-forwarded-proto` / `x-forwarded-host` (Sync-in's standard
  // assumption that the reverse proxy is the source of truth for the
  // externally-visible URL). Same convention every other part of Sync-in
  // uses; the deployment is expected to configure the proxy correctly.
  //
  // The OIDC *callback* URL is unrelated to the mobile-facing host —
  // callback construction reads `auth.oidc.redirectUri` directly in
  // NcMobileOidcController. Previous versions of this method conflated
  // the two, which broke deployments where the OIDC redirect host and
  // the mobile-facing host differ.
  baseUrl(_req: FastifyRequest): string {
    const proto = (_req.headers['x-forwarded-proto'] as string | undefined) ?? (_req.protocol as string | undefined) ?? 'http'
    const host = (_req.headers['x-forwarded-host'] as string | undefined) ?? (_req.headers['host'] as string | undefined) ?? 'localhost'
    return `${proto}://${host}`
  }
}
