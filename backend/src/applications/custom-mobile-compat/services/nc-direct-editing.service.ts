import { createHash } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { JwtIdentityPayload } from '../../../authentication/interfaces/jwt-payload.interface'
import { configuration } from '../../../configuration/config.environment'
import type { UserModel } from '../../users/models/user.model'

// NC iOS gates the Edit affordance on the editor *name* (lowercased) being
// one of `"nextcloud text"` or `"onlyoffice"` — see
// `iOSClient/Data/NCManageDatabase+Metadata.swift::isAvailableDirectEditingEditorView`.
// Anything else and the button never appears, no matter what mimetypes we
// advertise. The id is opaque to iOS (passed back to /open as ?editorId=).
export const NC_DIRECT_EDITING_EDITOR_ID = 'sync-in-text'
export const NC_DIRECT_EDITING_EDITOR_NAME = 'Nextcloud Text'

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
    if (!mime) return false
    // Sync-in stores mimes with the first `/` replaced by `-`. Normalize
    // back to the canonical form before comparing against the catalog.
    const normalized = mime.includes('/') ? mime : mime.replace('-', '/')
    return NC_DIRECT_EDITING_MIMETYPES.includes(normalized)
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

function buildEditorsCatalog(): Record<string, NcDirectEditor> {
  return {
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
}

export function ncDirectEditingCatalogEtag(): string {
  const catalog = JSON.stringify({ editors: buildEditorsCatalog(), creators: {} })
  return createHash('sha256').update(catalog).digest('hex').slice(0, 16)
}
