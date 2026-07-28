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

  // OCS activity feed. Deliberately NOT advertised in capabilities — see
  // controllers/nc-activity.controller.ts for why serving it is what makes NC
  // Android's file-detail list (versions included) render at all.
  OCS_ACTIVITY: '/ocs/v2.php/apps/activity/api/v2/activity',
  OCS_ACTIVITY_FILTER: '/ocs/v2.php/apps/activity/api/v2/activity/filter',

  // Avatar + preview
  AVATAR: '/index.php/avatar/:user/:size',
  PREVIEW: '/index.php/core/preview',

  // OnlyOffice connector (NC plugin protocol). Mounted when EITHER
  // applications.files.editors.onlyoffice.enabled or
  // applications.files.editors.eurooffice.enabled is true — see
  // CustomMobileCompatModule.
  //
  // There is deliberately no /index.php/apps/eurooffice/* mirror. In Nextcloud
  // a route prefix under /apps/<id>/ IS the installed app id, and the only
  // office connector app is `onlyoffice` — every route in
  // ONLYOFFICE/onlyoffice-nextcloud appinfo/routes.php hangs off that one id
  // (/download, /empty, /track, /save, ...). Euro-Office is not a second NC
  // app; it is an OnlyOffice-protocol document server, and both stock clients
  // treat it that way:
  //   - Android: EditorUtils.kt keeps `OFFICE_EDITOR_IDS = setOf("onlyoffice",
  //     "eurooffice")` and matches it against the directEditing catalog's
  //     `Editor.id` — it never derives a URL prefix from the editor name.
  //   - iOS: NCDirectEditorAdapter.swift maps the `"eurooffice"` editor id onto
  //     viewControllerEditor `"onlyoffice"` with the SAME OnlyOffice user agent.
  // So a parallel /apps/eurooffice/* prefix would be a path no client ever
  // requests. Euro-Office support is a config selection behind these routes,
  // not a second route family.
  //
  // Only ONE of the four below is a route the real connector serves. Checked
  // against ONLYOFFICE/onlyoffice-nextcloud appinfo/routes.php:
  //   ours                 upstream
  //   /config          →   (none) — the config endpoint is OCS,
  //                        /ocs/v2.php/apps/onlyoffice/api/v1/config/{fileId},
  //                        with the id in the PATH, not a query param
  //   /track           →   callback#track, POST /track                  ✓ match
  //   /empty  (POST)   →   callback#emptyfile is GET /empty, and it is the
  //                        DOC SERVER fetching a blank template — not a
  //                        create-a-document call. Creating one is
  //                        editor#create, POST /ajax/new
  //   /save   (POST)   →   editor#save is POST /ajax/save, and it is save-AS
  //                        (name + dir + url), not a forcesave trigger
  // So "the paths the mobile app expects" is an assumption, not a finding. It
  // costs nothing while it is unused, and if a client ever does show up speaking
  // the real protocol it will 404 on three of these. The upstream table also
  // carries /ajax/history, /ajax/version and /ajax/restore — the version-history
  // API that drives the editor's own history panel, which this fork has no
  // equivalent of.
  ONLYOFFICE_CONFIG: '/index.php/apps/onlyoffice/config',
  ONLYOFFICE_TRACK: '/index.php/apps/onlyoffice/track',
  ONLYOFFICE_EMPTY: '/index.php/apps/onlyoffice/empty',
  ONLYOFFICE_SAVE: '/index.php/apps/onlyoffice/save',

  // WebDAV (files, uploads, trashbin, versions)
  DAV_FILES_PREFIX: '/remote.php/dav/files',
  DAV_UPLOADS_PREFIX: '/remote.php/dav/uploads',
  DAV_TRASHBIN_PREFIX: '/remote.php/dav/trashbin',
  // The NC file-versions tree. Upstream's node layout is
  // versions/{user}/{versions|restore}/... — see
  // nextcloud/server apps/files_versions/lib/Sabre/VersionHome.php, which
  // exposes exactly those two children. Served by NcVersionsController.
  DAV_VERSIONS_PREFIX: '/remote.php/dav/versions',
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
