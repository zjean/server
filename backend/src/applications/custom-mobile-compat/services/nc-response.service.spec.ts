import type { FastifyRequest } from 'fastify'

// Mock the configuration module so we don't pull in the full class-validator
// + file-IO graph at test-load time. Tests mutate this object via `mockConfig`.
jest.mock('../../../configuration/config.environment', () => ({
  configuration: {
    auth: { oidc: { redirectUri: undefined as string | undefined } }
  }
}))

import { configuration } from '../../../configuration/config.environment'
import { NcResponseService } from './nc-response.service'

const mockConfig = configuration as unknown as { auth?: { oidc?: { redirectUri?: string } } }

function fakeReq(headers: Record<string, string>, protocol?: string): FastifyRequest {
  return { headers, protocol } as unknown as FastifyRequest
}

describe(NcResponseService.name, () => {
  let service: NcResponseService

  beforeEach(() => {
    service = new NcResponseService()
    mockConfig.auth = { oidc: { redirectUri: undefined } }
  })

  describe('baseUrl', () => {
    it('prefers x-forwarded-* headers when set', () => {
      const url = service.baseUrl(fakeReq({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'cloud.example.com' }))
      expect(url).toBe('https://cloud.example.com')
    })

    it('x-forwarded-* wins over OIDC redirect-URI host (regression guard for #211)', () => {
      // Pre-#211 behavior: OIDC redirect URI silently overrode proxy headers
      // even when the proxy was correctly forwarding the mobile-facing host.
      // The fix reorders resolution so proxy headers win.
      mockConfig.auth!.oidc!.redirectUri = 'https://oidc-callback.example.com/auth/oidc/callback'
      const url = service.baseUrl(fakeReq({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'cloud.example.com' }))
      expect(url).toBe('https://cloud.example.com')
      expect(url).not.toContain('oidc-callback')
    })

    it('falls back to OIDC redirect-URI origin when proxy did not set x-forwarded-host', () => {
      // Safety net for OIDC-enabled deployments where the proxy headers
      // aren't trusted (or aren't forwarded). Preserves the PR #138 stance
      // that an admin-set, non-spoofable answer beats a raw `host:` header.
      mockConfig.auth!.oidc!.redirectUri = 'https://cloud.example.com/auth/oidc/callback'
      const url = service.baseUrl(fakeReq({ host: 'attacker.example.com' }))
      expect(url).toBe('https://cloud.example.com')
    })

    it('falls back to host header when neither x-forwarded-host nor OIDC redirect URI is configured', () => {
      const url = service.baseUrl(fakeReq({ host: 'cloud.example.com' }))
      expect(url).toBe('http://cloud.example.com')
    })

    it('uses req.protocol for the scheme when x-forwarded-proto is absent', () => {
      const url = service.baseUrl(fakeReq({ host: 'cloud.example.com' }, 'https'))
      expect(url).toBe('https://cloud.example.com')
    })

    it('falls back to http://localhost when no headers and no OIDC redirect URI are present', () => {
      const url = service.baseUrl(fakeReq({}))
      expect(url).toBe('http://localhost')
    })
  })
})
