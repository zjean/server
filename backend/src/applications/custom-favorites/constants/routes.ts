import { APP_BASE_ROUTE } from '../../applications.constants'

// `BASE` carries the full `/api/app` prefix so the @Controller() decorator registers
// under the same namespace as every other application controller (mirrors how
// SPACES_ROUTE.BASE is built from APP_BASE_ROUTE in spaces/constants/routes.ts).
export const CUSTOM_FAVORITES_ROUTE = {
  BASE: `${APP_BASE_ROUTE}/favorites`,
  SPACES: 'spaces',
  IDS: 'ids'
} as const

// Imported by the v2 frontend (cross-package import, same pattern as API_SPACES_BROWSE).
// Resolves to `/api/app/favorites`.
export const API_CUSTOM_FAVORITES = CUSTOM_FAVORITES_ROUTE.BASE
