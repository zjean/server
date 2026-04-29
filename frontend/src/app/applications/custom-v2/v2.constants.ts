// Sync-In v2 — route + storage constants.
// Kept in a single place so the classic ui-version guard, the v2 layout, and
// the opt-in toggle all agree on spelling.

export const V2_PATH = 'v2' as const

// Child paths (relative to /v2). Kept as plain strings so routerLink arrays
// read naturally: ['/', V2_PATH, V2_ROUTES.RECENTS].
export const V2_ROUTES = {
  STUB: '',
  KIT: '_kit',
  RECENTS: 'recents',
  PERSONAL: 'personal',
  SPACES: 'spaces',
  SHARED: 'shared',
  SHARED_WITH_ME: 'shared/with-me',
  SHARED_WITH_OTHERS: 'shared/with-others',
  SHARED_VIA_LINKS: 'shared/via-links',
  TRASH: 'trash',
  PDF: 'pdf',
  PREVIEW: 'preview',
  FILE: 'file',
  SEARCH: 'search',
  SETTINGS: 'settings',
  PEOPLE: 'people',
  ADMIN: 'admin',
  ADMIN_USERS: 'admin/users',
  ADMIN_GROUPS: 'admin/groups',
  ADMIN_SPACES: 'admin/spaces',
  ADMIN_TOOLS: 'admin/tools'
} as const

export const UI_VERSION_STORAGE_KEY = 'ui.version'
export type UiVersion = 'classic' | 'v2'
