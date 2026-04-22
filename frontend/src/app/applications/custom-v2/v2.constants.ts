// Sync-In v2 — route + storage constants.
// Kept in a single place so the classic ui-version guard, the v2 layout, and
// the opt-in toggle all agree on spelling.

export const V2_PATH = 'v2' as const

export const UI_VERSION_STORAGE_KEY = 'ui.version'
export type UiVersion = 'classic' | 'v2'
