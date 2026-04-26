import { ncCapabilities } from './capabilities'

describe('ncCapabilities', () => {
  const caps = ncCapabilities('https://sync-in.example.test')

  it('advertises NC v33 server identity', () => {
    expect(caps.version.major).toBe(33)
    expect(caps.version.string).toBe('33.0.0-sync-in')
  })

  describe('provisioning_api block', () => {
    // NC iOS reads `capabilities.provisioning_api.version` to gate the
    // /ocs/v2.php/cloud/user* endpoints. Without it, some iOS builds bail with
    // a generic "Fout" alert immediately after sign-in completes.
    it('exposes a version string compatible with NC 33.x', () => {
      const block = (caps.capabilities as Record<string, Record<string, unknown>>).provisioning_api
      expect(block).toBeDefined()
      expect(block.version).toEqual(expect.any(String))
      expect(block.version).toMatch(/^\d+\.\d+\.\d+$/)
    })

    it('exposes AccountPropertyScopes flags expected by NC iOS ≥ 33', () => {
      const block = (caps.capabilities as Record<string, Record<string, unknown>>).provisioning_api
      expect(block.AccountPropertyScopesVersion).toEqual(expect.any(Number))
      expect(block.AccountPropertyScopesFederatedEnabled).toEqual(expect.any(Boolean))
      expect(block.AccountPropertyScopesPublishedEnabled).toEqual(expect.any(Boolean))
    })
  })

  it('still does NOT advertise notifications / activity (intentional — see code comment)', () => {
    expect((caps.capabilities as Record<string, unknown>).notifications).toBeUndefined()
    expect((caps.capabilities as Record<string, unknown>).activity).toBeUndefined()
  })

  it('still hides the share UI (files_sharing.api_enabled = false)', () => {
    const block = (caps.capabilities as Record<string, Record<string, unknown>>).files_sharing
    expect(block.api_enabled).toBe(false)
  })

  it('advertises dav.sync-token so NC iOS uses REPORT instead of PROPFIND-polling', () => {
    // RFC 6578 sync-collection support. Implemented in NcSyncReportService
    // (PR #94). Removing this flag silently regresses mobile auto-refresh
    // back to "manual-only" on pull-to-refresh / app foreground.
    const block = (caps.capabilities as Record<string, Record<string, unknown>>).dav
    expect(block['sync-token']).toBe(true)
  })
})
