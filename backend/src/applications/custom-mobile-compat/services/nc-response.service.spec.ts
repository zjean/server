import type { FastifyRequest } from 'fastify'
import { NcResponseService } from './nc-response.service'

function fakeReq(headers: Record<string, string>, protocol?: string): FastifyRequest {
  return { headers, protocol } as unknown as FastifyRequest
}

describe(NcResponseService.name, () => {
  let service: NcResponseService

  beforeEach(() => {
    service = new NcResponseService()
  })

  describe('baseUrl', () => {
    it('derives the mobile-facing URL from x-forwarded-* headers', () => {
      const url = service.baseUrl(fakeReq({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'cloud.example.com' }))
      expect(url).toBe('https://cloud.example.com')
    })

    it('falls back to host header when no x-forwarded-host is present', () => {
      const url = service.baseUrl(fakeReq({ host: 'cloud.example.com' }))
      expect(url).toBe('http://cloud.example.com')
    })

    it('uses req.protocol when no x-forwarded-proto is present', () => {
      const url = service.baseUrl(fakeReq({ host: 'cloud.example.com' }, 'https'))
      expect(url).toBe('https://cloud.example.com')
    })

    it('falls back to http://localhost when no headers are present', () => {
      const url = service.baseUrl(fakeReq({}))
      expect(url).toBe('http://localhost')
    })

    it('OIDC redirect-URI host does not leak into baseUrl (regression guard for #211)', () => {
      // Pre-fix behavior: when auth.oidc.redirectUri was set, baseUrl()
      // returned the OIDC origin even if the mobile-facing host was different
      // — capabilities and login-v2 silently advertised the wrong server.
      // The fix removes that branch entirely; baseUrl is now header-derived
      // only, and OIDC callback construction lives in NcMobileOidcController.
      const url = service.baseUrl(fakeReq({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'cloud.example.com' }))
      expect(url).toBe('https://cloud.example.com')
    })
  })
})
