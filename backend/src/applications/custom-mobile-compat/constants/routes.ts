// Nextcloud-compatible routes exposed by this module.
// Paths match what stock Nextcloud iOS / Android clients hit; see
// https://github.com/AtalayaLabs/OxiCloud/blob/main/src/interfaces/nextcloud/routes.rs
// for the reference list we mirror.

export const NC_ROUTE = {
  // Discovery + probes (public)
  STATUS_PHP: '/status.php',
  CONNECTIVITY_204: '/index.php/204',
  DAV_PROBE: '/remote.php/dav',
  DAV_PROBE_SLASH: '/remote.php/dav/',

  // Login flow v2 (public)
  LOGIN_V2: '/index.php/login/v2',
  LOGIN_V2_POLL: '/index.php/login/v2/poll',
  LOGIN_V2_POLL_ALT: '/login/v2/poll',
  LOGIN_V2_FLOW: '/login/v2/flow/:token',

  // Mobile OIDC delegation (only mounted when auth.provider === 'oidc')
  MOBILE_OIDC_LOGIN: '/custom-mobile/oidc/login/:token',
  MOBILE_OIDC_CALLBACK: '/custom-mobile/oidc/callback',

  // OCS (capabilities public, others require app-password)
  OCS_CAPABILITIES_V1: '/ocs/v1.php/cloud/capabilities',
  OCS_CAPABILITIES_V2: '/ocs/v2.php/cloud/capabilities',
  OCS_USER: '/ocs/v2.php/cloud/user',
  OCS_USERS_V1: '/ocs/v1.php/cloud/users/:userid',
  OCS_USERS_V2: '/ocs/v2.php/cloud/users/:userid',
  OCS_APP_PASSWORD: '/ocs/v2.php/core/apppassword',

  // Avatar + preview
  AVATAR: '/index.php/avatar/:user/:size',
  PREVIEW: '/index.php/core/preview',

  // OnlyOffice connector (NC plugin protocol). Mounted only when
  // applications.files.onlyoffice.enabled === true (see CustomMobileCompatModule).
  ONLYOFFICE_CONFIG: '/index.php/apps/onlyoffice/config',
  ONLYOFFICE_TRACK: '/index.php/apps/onlyoffice/track',
  ONLYOFFICE_EMPTY: '/index.php/apps/onlyoffice/empty',
  ONLYOFFICE_SAVE: '/index.php/apps/onlyoffice/save',

  // WebDAV (files, uploads, trashbin)
  DAV_FILES_PREFIX: '/remote.php/dav/files',
  DAV_UPLOADS_PREFIX: '/remote.php/dav/uploads',
  DAV_TRASHBIN_PREFIX: '/remote.php/dav/trashbin',
  LEGACY_WEBDAV_PREFIX: '/remote.php/webdav'
} as const

// Root path (no leading slash) used for Nest controller @Controller() decorators.
// Nest strips leading '/' from @Controller args; keep constants human-readable above
// and convert to decorator form here.
export function ctrlPath(route: string): string {
  return route.startsWith('/') ? route.slice(1) : route
}

// Basic-Auth realm advertised by the guard and the DAV probe. Shown by iOS in
// the system credential prompt ("Sign in to <realm>") and stored alongside the
// password in some keychain pickers — keep it on-brand.
export const NC_AUTH_REALM = 'Sync-in'
