// Static capabilities payload returned from /ocs/v{1,2}.php/cloud/capabilities.
// Values are tuned to tell stock NC mobile clients which features are available.
//
// - version advertised as 29.0.0 with an -sync-in edition suffix; clients gate
//   some behavior on a server major >= 26 (login-v2 required, dav chunking v2).
// - files_sharing.api_enabled: false hides the Share button in the mobile UI —
//   we do not ship OCS sharing in this MVP.
// - dav.chunking: "1.0" is the protocol mobile clients use; v2 is desktop-only.

export interface NcCapabilitiesPayload {
  version: {
    major: number
    minor: number
    micro: number
    string: string
    edition: string
    extendedSupport: boolean
  }
  capabilities: Record<string, unknown>
}

export function ncCapabilities(serverUrl: string): NcCapabilitiesPayload {
  return {
    version: {
      major: 29,
      minor: 0,
      micro: 0,
      string: '29.0.0-sync-in',
      edition: '',
      extendedSupport: false
    },
    capabilities: {
      core: {
        pollinterval: 60,
        'webdav-root': 'remote.php/webdav',
        'reference-api': false,
        'reference-regex': ''
      },
      bruteforce: { delay: 0, 'whitelisted-ips': [] },
      files: {
        bigfilechunking: true,
        blacklisted_files: [],
        directEditing: { url: '', etag: '' },
        comments: false,
        undelete: true,
        versioning: false,
        // Preview available for image mimes via /index.php/core/preview?file=<path>.
        // Non-images return 404 and the client falls back to a download.
        preview: true
      },
      dav: {
        chunking: '1.0',
        trashbin: '1.0',
        bulkupload: '1.0'
      },
      theming: {
        name: 'Sync-in',
        url: serverUrl,
        slogan: '',
        color: '#0082c9',
        'color-text': '#ffffff',
        'color-element': '#0082c9',
        'color-element-bright': '#0082c9',
        'color-element-dark': '#0082c9',
        logo: `${serverUrl}/favicon.ico`,
        background: '',
        'background-plain': true,
        'background-default': true
      },
      user_status: {
        enabled: false
      },
      // checksums advertised with an empty supportedTypes list. The NC iOS
      // client reads this to decide whether to send OC-Checksum upload
      // headers; an empty list makes it skip checksum computation entirely,
      // which matches our current upload path (we don't verify checksums
      // server-side). This mirrors OxiCloud's posture.
      checksums: {
        preferredUploadType: '',
        supportedTypes: [] as string[]
      },
      files_sharing: {
        api_enabled: false,
        resharing: false,
        public: { enabled: false },
        user: { send_mail: false },
        group: { enabled: false },
        default_permissions: 1,
        federation: { outgoing: false, incoming: false }
      }
      // Deliberately NOT advertising `notifications` or `activity` — an empty
      // ocs-endpoints array still prompts the iOS client to probe
      // /ocs/v2.php/apps/notifications/... and log 404s; omitting the key
      // entirely tells the client the feature is unavailable.
    }
  }
}
