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

  // Compute the server's externally-visible base URL from the request headers.
  // Respects X-Forwarded-Proto / X-Forwarded-Host if present (Sync-in sits
  // behind a reverse proxy in most deployments).
  baseUrl(req: FastifyRequest): string {
    const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? (req.protocol as string | undefined) ?? 'http'
    const host = (req.headers['x-forwarded-host'] as string | undefined) ?? (req.headers['host'] as string | undefined) ?? 'localhost'
    return `${proto}://${host}`
  }
}
