import { createHash } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { JwtIdentityPayload } from '../../../authentication/interfaces/jwt-payload.interface'
import { configuration } from '../../../configuration/config.environment'
import { ONLY_OFFICE_EXTENSIONS } from '../../files/editors/only-office/only-office.constants'
import { getMimeType } from '../../files/utils/files'
import type { UserModel } from '../../users/models/user.model'

// Both stock NC clients pick an editor by its *id*, matched against a hardcoded
// registry, and the id also decides which user agent the host webview uses:
//   - iOS: `NCDirectEditorAdapter.resolve` keys on the lowercased id and knows
//     `text`, `onlyoffice`, `eurooffice`, `whiteboard`. `eurooffice` maps onto
//     the same OnlyOffice user agent and the same view controller.
//   - Android: `EditorUtils.kt::OFFICE_EDITOR_IDS = setOf("onlyoffice",
//     "eurooffice")`, matched against `Editor.id`.
// So an id outside those sets is an editor no client will ever open. Older iOS
// builds additionally gated on the lowercased *name* being `"nextcloud text"` or
// `"onlyoffice"` — which is why the names below are chosen to satisfy both the
// old name check and the current id check.
export const NC_DIRECT_EDITING_EDITOR_ID = 'text'
export const NC_DIRECT_EDITING_EDITOR_NAME = 'Nextcloud Text'

// The office entry's id follows whichever document server is configured, with
// the same precedence OnlyOfficeManager itself uses when both are enabled
// (only-office-manager.service.ts:83-86) so the advertised editor always names
// the server that will actually serve it. Null when no office document server is
// enabled — the catalog then carries the text editor alone, exactly as before.
export type NcOfficeEditorId = 'onlyoffice' | 'eurooffice'

export function ncOfficeEditorId(): NcOfficeEditorId | null {
  if (configuration.applications.files.editors.onlyoffice?.enabled === true) return 'onlyoffice'
  if (configuration.applications.files.editors.eurooffice?.enabled === true) return 'eurooffice'
  return null
}

// 'OnlyOffice' deliberately, not upstream's 'ONLYOFFICE': it lowercases to
// exactly the string older iOS builds compared against.
const NC_OFFICE_EDITOR_NAMES: Record<NcOfficeEditorId, string> = {
  onlyoffice: 'OnlyOffice',
  eurooffice: 'Euro-Office'
}

// Which of OnlyOffice's five document classes we advertise as editable.
//
// `pdf` and `diagram` are left out on purpose. iOS routes every PDF to its own
// NCViewerPDF before it ever consults the catalog (NCViewer.swift), so
// advertising `application/pdf` would light up an Edit action on Android alone —
// an asymmetry with no upside. Diagrams are view-only in OnlyOffice.
const NC_OFFICE_DOCUMENT_TYPES: ReadonlySet<string> = new Set(['word', 'cell', 'slide'])

// Mimes that an office document class claims but that belong to another editor,
// or to no editor at all:
//   - text/csv is already in the text catalog above, where CodeMirror handles it
//     far better than a spreadsheet round-trip would.
//   - message/rfc822 is what .mht/.mhtml resolve to; it is the mail mime, and
//     claiming it would offer to "edit" saved messages.
const NC_OFFICE_MIME_EXCLUSIONS: ReadonlySet<string> = new Set(['text/csv', 'message/rfc822'])

// Token TTL. Short enough that a leaked editor URL stops working quickly,
// long enough that a user can open a file, walk away briefly, and still save.
// 15 min is the same ballpark as upstream NC's text-app one-time tokens.
export const NC_DIRECT_EDITING_TOKEN_TTL_SEC = 15 * 60

// Scope claim on the JWT — narrows the token's blast radius if someone
// mints a generic access token from the same secret. Editor endpoints
// must verify both the signature *and* this scope value.
const TOKEN_SCOPE = 'nc-direct-editing:edit'

// Mimetypes the editor advertises. Intentionally narrow: things a textarea/
// CodeMirror in a WKWebView can edit usefully. Binary formats, archives, and
// images are excluded — and so are docx/xlsx/pptx, which OnlyOffice handles.
//
// Sync-in stores mimes with the first `/` replaced by `-` (e.g. `text-plain`),
// but every place this list is *advertised* — capabilities, /info responses,
// matched against iOS — uses the canonical slash form. The dash form is only
// accepted defensively in `isEditableMime` for callers that pull straight
// from the DB.
//
// Exported so capabilities.ts can fold the same list into the catalog etag
// it advertises; iOS uses that etag to invalidate its cached editor list.
export const NC_DIRECT_EDITING_MIMETYPES: readonly string[] = Object.freeze([
  'text/plain',
  'text/markdown',
  'text/html',
  'text/css',
  'text/csv',
  'text/xml',
  'text/javascript',
  'text/x-python',
  'text/x-shellscript',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/x-sh'
])

// The office editor's mimetypes, DERIVED from the extensions OnlyOfficeManager
// will actually accept rather than hand-listed.
//
// The derivation runs each extension through the very functions the DAV layer
// uses to emit `d:getcontenttype` — `getMimeType`, then the same first-dash
// reversal WebDAVFile does — because both clients compare the advertised
// mimetype to that emitted string with EXACT equality
// (NCUtility.swift::editorsDirectEditing, EditorUtils.kt::getEditor). A
// hand-maintained list is exactly how the two drift apart, and a drifted entry
// fails silently: no Edit affordance, no error anywhere.
//
// Extensions `mime-types` does not know (fb2, fodt, hwp, et, fods, dps, …) yield
// `file`, carry no '/' and drop out here. They are genuinely unaddressable — the
// server has no mime to advertise them under.
export const NC_DIRECT_EDITING_OFFICE_MIMETYPES: readonly string[] = Object.freeze(buildOfficeMimetypes())

function buildOfficeMimetypes(): string[] {
  const mimes = new Set<string>()
  for (const [extension, documentType] of ONLY_OFFICE_EXTENSIONS) {
    if (!NC_OFFICE_DOCUMENT_TYPES.has(documentType)) continue
    const emitted = getMimeType(`f.${extension}`, false).replace('-', '/')
    if (!emitted.includes('/')) continue
    if (NC_OFFICE_MIME_EXCLUSIONS.has(emitted)) continue
    mimes.add(emitted)
  }
  return [...mimes].sort()
}

export interface NcDirectEditor {
  id: string
  name: string
  mimetypes: string[]
  optionalMimetypes: string[]
  secure: boolean
}

export interface NcDirectCreator {
  id: string
  editor: string
  name: string
  extension: string
  templates: boolean
  mimetype: string
}

export interface NcDirectEditClaims {
  // Full identity payload — same shape carried by Sync-in's normal access
  // tokens. Embedding it here lets the editor controller reconstruct a
  // UserModel via `new UserModel(identity)` without a DB hit per request,
  // mirroring what OnlyOfficeStrategy does on its query-token surface.
  identity: JwtIdentityPayload
  fileId: number
}

interface InternalEditTokenPayload {
  identity: JwtIdentityPayload
  fileId: number
  scope: string
}

// Catalog + token mint/verify for the NC iOS direct-editing surface.
//
// What iOS does end-to-end:
//   1. /info → list editors. iOS picks one whose mimetypes match the file's
//      content-type AND whose name (lowercased) is "nextcloud text".
//   2. /open?path=...&editorId=...&fileId=... → returns { url } pointing at
//      our token-bearing editor page.
//   3. WKWebView loads that URL. The editor calls back to our content GET/PUT
//      endpoints using the token (NOT Basic Auth — WKWebView doesn't share
//      session cookies/Authorization with the OCS auth path).
//
// This service owns (1) the static catalog and its etag, and (3) the token
// scheme used by the editor page. Step (2) is in the controller.
@Injectable()
export class NcDirectEditingService {
  constructor(private readonly jwt: JwtService) {}

  listEditors(): Record<string, NcDirectEditor> {
    return buildEditorsCatalog()
  }

  listCreators(): Record<string, NcDirectCreator> {
    // No template creation yet — NC iOS doesn't need this for editing
    // existing files. Future work: expose `.txt`/`.md` creators.
    return {}
  }

  // SHA-256-derived short hash of the catalog JSON. iOS uses this to
  // invalidate its cached editor list — if we extend mimetypes, the etag
  // changes, iOS refetches /info. Stable across calls for the same catalog.
  editorCatalogEtag(): string {
    return ncDirectEditingCatalogEtag()
  }

  isEditableMime(mime: string | undefined | null): boolean {
    return matchesCatalog(mime, NC_DIRECT_EDITING_MIMETYPES)
  }

  // Second layer for the office editor page. The catalog is what makes the Edit
  // affordance appear; this is what makes the page refuse to open a file the
  // catalog never claimed — so "advertised" and "served" cannot drift apart.
  isOfficeMime(mime: string | undefined | null): boolean {
    return matchesCatalog(mime, NC_DIRECT_EDITING_OFFICE_MIMETYPES)
  }

  // The office editor id currently advertised, or null when no office document
  // server is enabled. Exposed so the /open handler can accept it as an
  // `editorId` without reaching for `configuration` itself.
  officeEditorId(): NcOfficeEditorId | null {
    return ncOfficeEditorId()
  }

  async mintEditToken(args: { user: UserModel; fileId: number }): Promise<string> {
    const identity = identityFromUser(args.user)
    const payload: InternalEditTokenPayload = { identity, fileId: args.fileId, scope: TOKEN_SCOPE }
    return this.jwt.signAsync(payload, {
      secret: configuration.auth.token.access.secret,
      expiresIn: NC_DIRECT_EDITING_TOKEN_TTL_SEC
    })
  }

  async verifyEditToken(token: string): Promise<NcDirectEditClaims> {
    const decoded = await this.jwt.verifyAsync<InternalEditTokenPayload>(token, {
      secret: configuration.auth.token.access.secret
    })
    if (
      !decoded ||
      decoded.scope !== TOKEN_SCOPE ||
      !decoded.identity ||
      typeof decoded.identity.id !== 'number' ||
      typeof decoded.identity.login !== 'string' ||
      typeof decoded.fileId !== 'number'
    ) {
      throw new Error('invalid direct-editing token')
    }
    return { identity: decoded.identity, fileId: decoded.fileId }
  }
}

// Sync-in stores mimes with the first `/` replaced by `-`. Normalize back to the
// canonical form before comparing against a catalog list — callers may hand over
// either form depending on whether they pulled from the DB or from REST.
function matchesCatalog(mime: string | undefined | null, catalog: readonly string[]): boolean {
  if (!mime) return false
  const normalized = mime.includes('/') ? mime : mime.replace('-', '/')
  return catalog.includes(normalized)
}

// Build a JwtIdentityPayload from a UserModel. UserModel carries everything
// needed; we just whittle it down to the fields the access-token strategy
// stores. Anything extra (paths, secrets, etc.) is intentionally dropped.
function identityFromUser(user: UserModel): JwtIdentityPayload {
  return {
    id: user.id,
    login: user.login,
    email: user.email,
    fullName: user.fullName,
    language: user.language,
    role: user.role,
    applications: user.applications ?? [],
    clientId: user.clientId
  }
}

// Standalone helpers shared with capabilities.ts (which can't depend on DI).
// Both the OCS /info handler and the capabilities advertisement go through
// these so the etag iOS sees in capabilities matches the catalog it gets
// back from /info.

// Key insertion order is load-bearing on Android and nowhere else. Its
// `getAvailableEditor` returns `editors.firstOrNull { mime in it.mimetypes }`
// over a Gson-deserialized LinkedHashMap, so on any mimetype two editors claim,
// the one declared FIRST wins. Text comes first deliberately: it is the cheaper,
// more faithful editor for anything both could open. (iOS needs no such care —
// NCViewer.swift forces `["text"]` whenever text matches at all.)
function buildEditorsCatalog(): Record<string, NcDirectEditor> {
  const catalog: Record<string, NcDirectEditor> = {
    [NC_DIRECT_EDITING_EDITOR_ID]: {
      id: NC_DIRECT_EDITING_EDITOR_ID,
      name: NC_DIRECT_EDITING_EDITOR_NAME,
      mimetypes: [...NC_DIRECT_EDITING_MIMETYPES],
      optionalMimetypes: [],
      // `secure` advertises Files-Access-Control compatibility upstream;
      // we don't gate on FAC and don't honor it, so report false.
      secure: false
    }
  }
  const officeId = ncOfficeEditorId()
  if (officeId) {
    catalog[officeId] = {
      id: officeId,
      name: NC_OFFICE_EDITOR_NAMES[officeId],
      mimetypes: [...NC_DIRECT_EDITING_OFFICE_MIMETYPES],
      optionalMimetypes: [],
      secure: false
    }
  }
  return catalog
}

export function ncDirectEditingCatalogEtag(): string {
  // Must fold EVERY field of the /info body. Android refetches the catalog only
  // when this etag differs from the one it stored (RefreshFolderOperation, keyed
  // on DIRECT_EDITING_ETAG), so a change the etag does not cover is a change
  // Android never sees. `creators` is still literally empty — the day it stops
  // being, it has to be read from the same place /info reads it.
  const catalog = JSON.stringify({ editors: buildEditorsCatalog(), creators: {} })
  return createHash('sha256').update(catalog).digest('hex').slice(0, 16)
}
