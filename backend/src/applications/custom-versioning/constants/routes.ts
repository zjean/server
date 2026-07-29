import { FILES_ROUTE } from '../../files/constants/routes'

// Version endpoints live in the files route namespace, because every one of
// them addresses a file: the space path is the trailing wildcard, exactly as
// in the files controller, and SpaceGuard resolves it from `req.params['*']`.
//
// Shape is `versions/<verb>/[:versionId/]*`, mirroring the files controller's
// `operation/<verb>/*`. The verb comes BEFORE the id on purpose: a bare
// `versions/*` route would also match `versions/12/content/foo`, leaving the
// router to disambiguate a wildcard against a param. A distinct static segment
// after `versions/` makes every route unambiguous.
export const VERSIONS_ROUTE = {
  BASE: FILES_ROUTE.BASE,
  VERSIONS: 'versions',
  LIST: 'list',
  USAGE: 'usage',
  CONTENT: 'content',
  RESTORE: 'restore',
  LABEL: 'label',
  DELETE: 'delete',
  DIFF: 'diff',
  // The OnlyOffice / Euro-Office editor's own version-history protocol. Three
  // are called by the editor's event handlers running IN THE PAGE and are
  // ordinary SpaceGuard routes like everything above; EDITOR_CONTENT is fetched
  // by the DOCUMENT SERVER, server-to-server, and therefore lives on a separate
  // controller under `@OnlyOfficeEnvironment()` — see
  // versions-office.controller.ts for why that cannot be a second guard stack
  // here.
  //
  // The `:version` in the first three is an ORDINAL into the history array, not
  // a row id. The editor has no other handle on a revision.
  EDITOR_HISTORY: 'editor-history',
  EDITOR_VERSION: 'editor-version',
  EDITOR_RESTORE: 'editor-restore',
  EDITOR_CONTENT: 'editor-content',
  // Instance-wide operator endpoints (#342). They carry NO trailing wildcard —
  // they address the whole store, not a file — so they never collide with the
  // per-file routes above, every one of which has a distinct static verb.
  ADMIN: 'admin',
  STORAGE: 'storage',
  PURGE: 'purge'
} as const

const NS = `${VERSIONS_ROUTE.BASE}/${VERSIONS_ROUTE.VERSIONS}`

export const API_VERSIONS_LIST = `${NS}/${VERSIONS_ROUTE.LIST}`
export const API_VERSIONS_USAGE = `${NS}/${VERSIONS_ROUTE.USAGE}`
export const API_VERSIONS_CONTENT = `${NS}/${VERSIONS_ROUTE.CONTENT}`
export const API_VERSIONS_RESTORE = `${NS}/${VERSIONS_ROUTE.RESTORE}`
export const API_VERSIONS_LABEL = `${NS}/${VERSIONS_ROUTE.LABEL}`
export const API_VERSIONS_DELETE = `${NS}/${VERSIONS_ROUTE.DELETE}`
export const API_VERSIONS_DIFF = `${NS}/${VERSIONS_ROUTE.DIFF}`

export const API_VERSIONS_EDITOR_HISTORY = `${NS}/${VERSIONS_ROUTE.EDITOR_HISTORY}`
export const API_VERSIONS_EDITOR_VERSION = `${NS}/${VERSIONS_ROUTE.EDITOR_VERSION}`
export const API_VERSIONS_EDITOR_RESTORE = `${NS}/${VERSIONS_ROUTE.EDITOR_RESTORE}`
export const API_VERSIONS_EDITOR_CONTENT = `${NS}/${VERSIONS_ROUTE.EDITOR_CONTENT}`

const ADMIN_NS = `${NS}/${VERSIONS_ROUTE.ADMIN}`

export const API_VERSIONS_ADMIN_STORAGE = `${ADMIN_NS}/${VERSIONS_ROUTE.STORAGE}`
export const API_VERSIONS_ADMIN_PURGE = `${ADMIN_NS}/${VERSIONS_ROUTE.PURGE}`
