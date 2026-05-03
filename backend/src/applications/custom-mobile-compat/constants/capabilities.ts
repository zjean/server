import { configuration } from '../../../configuration/config.environment'

// Static capabilities payload returned from /ocs/v{1,2}.php/cloud/capabilities.
// Values are tuned to tell stock NC mobile clients which features are available.
//
// - version advertised as 33.0.0 with an -sync-in edition suffix to match the
//   modern NC mobile clients (iOS 33.x). Clients gate some behavior on a
//   server major >= 26 (login-v2 required, dav chunking v2); 33 is fine.
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

// OnlyOffice connector capability block. NC mobile (and the OnlyOffice
// Documents app on its Nextcloud connection) gate the "Open with OnlyOffice"
// action on this object's presence. Mimetypes mirror what NC's plugin
// advertises so the mobile app's mimetype-gate matches.
const ONLYOFFICE_CAPABILITY = {
  version: '9.0.0',
  mimetypes: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ],
  templates: ['docx', 'xlsx', 'pptx']
} as const

export function ncCapabilities(serverUrl: string): NcCapabilitiesPayload {
  const onlyofficeBlock = configuration.applications.files.onlyoffice.enabled ? { onlyoffice: ONLYOFFICE_CAPABILITY } : {}

  return {
    version: {
      major: 33,
      minor: 0,
      micro: 0,
      string: '33.0.0-sync-in',
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
        // NC iOS gates the per-file Comments tab on this flag. We back it with
        // /remote.php/dav/comments/files/{fileId} (PROPFIND/POST/PROPPATCH/DELETE)
        // mapped onto Sync-in's existing comments app — see
        // controllers/nc-comments.controller.ts. MVP: personal-space files only
        // (FilesQueries.getUserFile is owner-scoped, mirroring the OnlyOffice
        // resolver constraint), no per-user unread tracking (isUnread is always
        // false; the readMarker PROPPATCH is accepted as a no-op).
        comments: true,
        undelete: true,
        versioning: false,
        // Preview available for image mimes via /index.php/core/preview?file=<path>.
        // Non-images return 404 and the client falls back to a download.
        preview: true,
        ...onlyofficeBlock
      },
      dav: {
        chunking: '1.0',
        trashbin: '1.0',
        bulkupload: '1.0',
        // RFC 6578 sync-collection support — turns NC iOS / Android refresh
        // from PROPFIND-polling into REPORT-incremental, ~1s latency from
        // a server-side or other-device change. Implementation lives in
        // NcSyncReportService + NcSyncLogService (PRs #92 / #94).
        'sync-token': true
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
        logo: `${serverUrl}/index.php/apps/theming/image/logo`,
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
      },
      // NC iOS reads `provisioning_api.version` to confirm `/ocs/v2.php/cloud/user`
      // and `/cloud/users/<me>` are valid endpoints. Without this block, some
      // iOS builds bail with a generic error after sign-in. Values mirror what
      // upstream NC 33.x ships.
      provisioning_api: {
        version: '1.22.0',
        AccountPropertyScopesVersion: 2,
        AccountPropertyScopesFederatedEnabled: true,
        AccountPropertyScopesPublishedEnabled: true
      },
      // The Recommendations app (https://github.com/nextcloud/recommendations)
      // advertises this block from its Capabilities.php; NC iOS uses it to
      // gate showing the Files-tab "Recommended files" carousel and only
      // calls /ocs/v2.php/apps/recommendations/api/v1/recommendations when
      // `enabled` is truthy. We always emit `enabled: true` because there's
      // no per-user opt-out in this fork — server-side, an empty result set
      // produces an empty (but rendered) carousel container.
      recommendations: {
        enabled: true
      }
      // Deliberately NOT advertising `notifications` or `activity` — an empty
      // ocs-endpoints array still prompts the iOS client to probe
      // /ocs/v2.php/apps/notifications/... and log 404s; omitting the key
      // entirely tells the client the feature is unavailable.
    }
  }
}
