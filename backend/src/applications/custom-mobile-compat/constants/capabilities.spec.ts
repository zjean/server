// Mock the config singleton — same pattern as nc-login-v2.controller.spec.ts.
// Loading the real config transitively pulls in class-validator decorators that
// require `reflect-metadata`, which isn't bootstrapped under vi.
vi.mock('../../../configuration/config.environment', () => ({
  configuration: {
    applications: {
      files: {
        editors: {
          onlyoffice: {
            enabled: false
          }
        },
        versions: {
          enabled: false
        }
      }
    }
  }
}))

import { configuration as mockConfig } from '../../../configuration/config.environment'

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

  it('advertises files_sharing.api_enabled = true so NC iOS renders the Shares tab', () => {
    // The Shares tab fetches /ocs/v2.php/apps/files_sharing/api/v1/shares —
    // served by NcOcsSharesController. Other knobs (resharing, public,
    // group, federation) stay false: we don't surface those flows through
    // NC mobile, and advertising them would make iOS probe endpoints we
    // intentionally don't implement.
    const block = (caps.capabilities as Record<string, Record<string, unknown>>).files_sharing
    expect(block.api_enabled).toBe(true)
    expect(block.resharing).toBe(false)
    expect((block.public as Record<string, unknown>).enabled).toBe(false)
    expect((block.group as Record<string, unknown>).enabled).toBe(false)
    expect((block.federation as Record<string, unknown>).outgoing).toBe(false)
    expect((block.federation as Record<string, unknown>).incoming).toBe(false)
  })

  describe('files.directEditing block', () => {
    // NC iOS gates the in-app Edit button for plain-text/source files on the
    // shape of this block. Without `url`, iOS skips the catalog fetch and
    // never lights up the button. Without `supportsFileId`, iOS may omit
    // `fileId` from /open calls — but we depend on it as the canonical id.
    it('points the catalog url at our /info endpoint on the same server', () => {
      const block = ((caps.capabilities as Record<string, Record<string, unknown>>).files as Record<string, unknown>).directEditing as {
        url: string
        etag: string
        supportsFileId: boolean
      }
      expect(block.url).toBe('https://sync-in.example.test/ocs/v2.php/apps/files/api/v1/directEditing')
    })

    it('advertises supportsFileId=true so iOS always sends fileId to /open', () => {
      const block = ((caps.capabilities as Record<string, Record<string, unknown>>).files as Record<string, unknown>).directEditing as {
        supportsFileId: boolean
      }
      expect(block.supportsFileId).toBe(true)
    })

    it('exposes a non-empty catalog etag so iOS invalidates its cached editor list when we change mimetypes', () => {
      const block = ((caps.capabilities as Record<string, Record<string, unknown>>).files as Record<string, unknown>).directEditing as {
        etag: string
      }
      // 16-hex-char SHA-256 prefix per ncDirectEditingCatalogEtag().
      expect(block.etag).toMatch(/^[a-f0-9]{16}$/)
    })
  })

  it('advertises files.comments=true so NC iOS shows the per-file Comments tab', () => {
    // Backed by NcCommentsController on /remote.php/dav/comments/files/{fileId}.
    // Flipping this to false silently hides the Comments tab in the file detail
    // view even when the endpoints work — iOS gates UI presence on this flag.
    const block = (caps.capabilities as Record<string, Record<string, unknown>>).files
    expect(block.comments).toBe(true)
  })

  it('advertises dav.sync-token so NC iOS uses REPORT instead of PROPFIND-polling', () => {
    // RFC 6578 sync-collection support. Implemented in NcSyncReportService
    // (PR #94). Removing this flag silently regresses mobile auto-refresh
    // back to "manual-only" on pull-to-refresh / app foreground.
    const block = (caps.capabilities as Record<string, Record<string, unknown>>).dav
    expect(block['sync-token']).toBe(true)
  })

  describe('files.onlyoffice block', () => {
    // NC mobile (and the OnlyOffice Documents app on its Nextcloud connection)
    // gate the "Open with OnlyOffice" action on the presence of this block.
    // Advertised only when applications.files.onlyoffice.enabled === true so
    // we don't lie about a feature the operator hasn't configured.
    afterEach(() => {
      mockConfig.applications.files.editors.onlyoffice.enabled = false
    })

    it('omits the block when onlyoffice is disabled', () => {
      mockConfig.applications.files.editors.onlyoffice.enabled = false
      const c = ncCapabilities('https://sync-in.example.test')
      const files = (c.capabilities as Record<string, Record<string, unknown>>).files
      expect(files.onlyoffice).toBeUndefined()
    })

    it('advertises mimetypes + templates when enabled', () => {
      mockConfig.applications.files.editors.onlyoffice.enabled = true
      const c = ncCapabilities('https://sync-in.example.test')
      const files = (c.capabilities as Record<string, Record<string, unknown>>).files
      const oo = files.onlyoffice as { version: string; mimetypes: string[]; templates: string[] }
      expect(oo).toBeDefined()
      expect(oo.mimetypes).toContain('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      expect(oo.mimetypes).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      expect(oo.mimetypes).toContain('application/vnd.openxmlformats-officedocument.presentationml.presentation')
      expect(oo.templates).toEqual(['docx', 'xlsx', 'pptx'])
      expect(oo.version).toMatch(/^\d+\.\d+\.\d+$/)
    })
  })

  // Shape taken verbatim from upstream's apps/files_versions/lib/Capabilities.php:
  //   ['files' => ['versioning' => true, 'version_labeling' => bool,
  //                'version_deletion' => bool]]
  // The key is `files.versioning`, NOT a top-level `files_versions` block — that
  // is the app id, not the capability. NextcloudKit decodes all three
  // (NextcloudKit+Capabilities.swift:294-309).
  describe('files versioning block', () => {
    afterEach(() => {
      mockConfig.applications.files.versions.enabled = false
    })

    const filesBlock = () => (ncCapabilities('https://sync-in.example.test').capabilities as Record<string, Record<string, unknown>>).files

    it('is not a top-level files_versions block — that is the app id, not the capability key', () => {
      mockConfig.applications.files.versions.enabled = true
      const c = ncCapabilities('https://sync-in.example.test')
      expect((c.capabilities as Record<string, unknown>).files_versions).toBeUndefined()
      expect(((c.capabilities as Record<string, Record<string, unknown>>).files as Record<string, unknown>).versioning).toBe(true)
    })

    // NC Android gates its ENTIRE version list on this flag being true
    // (FileDetailActivitiesFragment.java:253) before it PROPFINDs
    // /remote.php/dav/versions/{user}/versions/{fileId}. So the flag and
    // NcVersionsController have to agree, and they do — both read
    // files.versions.enabled.
    it('advertises all three flags when the feature is enabled', () => {
      mockConfig.applications.files.versions.enabled = true
      const files = filesBlock()
      expect(files.versioning).toBe(true)
      expect(files.version_labeling).toBe(true)
      expect(files.version_deletion).toBe(true)
    })

    // Matches what upstream looks like with the app disabled: absent, not
    // present-and-false. Advertising a flag whose endpoint 404s is the pattern
    // that got `dav.bulkupload` removed from this file.
    it('reports versioning=false and OMITS labeling/deletion while the flag is off', () => {
      mockConfig.applications.files.versions.enabled = false
      const files = filesBlock()
      expect(files.versioning).toBe(false)
      expect(files.version_labeling).toBeUndefined()
      expect(files.version_deletion).toBeUndefined()
    })

    it('defaults to off when the config carries no versions block at all', () => {
      const saved = mockConfig.applications.files.versions
      // A deployment on an older environment.yaml: absent must read as off, not
      // as a crash and not as on.
      delete (mockConfig.applications.files as Record<string, unknown>).versions
      try {
        expect(filesBlock().versioning).toBe(false)
      } finally {
        ;(mockConfig.applications.files as Record<string, unknown>).versions = saved
      }
    })
  })
})
