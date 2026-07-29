import { HttpStatus, Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { TOKEN_TYPE } from '../../../authentication/interfaces/token.interface'
import type { JwtPayload } from '../../../authentication/interfaces/jwt-payload.interface'
import { encodeUrl } from '../../../common/shared'
import { configuration } from '../../../configuration/config.environment'
import { Cache } from '../../../infrastructure/cache/cache.service'
import { ContextManager } from '../../../infrastructure/context/services/context-manager.service'
import { activeOfficeEditorSecret } from '../../custom-shared/utils/active-office-editor'
import { onlyOfficeDocKeyCacheKey } from '../../custom-shared/utils/only-office-doc-key'
import { API_ONLY_OFFICE_DOCUMENT } from '../../files/editors/only-office/only-office.routes'
import { ONLY_OFFICE_TOKEN_QUERY_PARAM_NAME } from '../../files/editors/only-office/only-office.constants'
import { FileError } from '../../files/models/file-error'
import { genEtag } from '../../files/utils/files'
import type { SpaceEnv } from '../../spaces/models/space-env.model'
import type { UserModel } from '../../users/models/user.model'
import { API_VERSIONS_EDITOR_CONTENT } from '../constants/routes'
import type { EditorHistoryEntry, EditorVersionData } from '../interfaces/editor-history.interface'
import type { VersionProps } from '../interfaces/version.interface'
import { VersioningService } from './versioning.service'

// Adapter between our versioning domain and the OnlyOffice document server's
// version-history protocol.
//
// A SEPARATE service from VersioningService on purpose: that class is the
// versioning domain — snapshots, retention, quota, restore safety — and none of
// what happens here belongs to it. Signing a payload for a third party's
// document server, mapping our row ids onto that party's ordinals, and building
// URLs a remote server can fetch are all adapter concerns. VersioningService is
// consumed, never extended.
//
// THE ORDINAL / ROW-ID BOUNDARY IS THIS CLASS. The editor knows nothing but
// 1-based ordinals into the history array; every mapping to a `files_versions.id`
// happens in here, server-side, from a list the caller's own SpaceGuard-resolved
// env produced. Accepting a row id from the editor would let a caller address
// another file's history by guessing numbers.
@Injectable()
export class EditorHistoryService {
  constructor(
    private readonly versioning: VersioningService,
    private readonly jwt: JwtService,
    private readonly cache: Cache,
    private readonly contextManager: ContextManager
  ) {}

  // The whole panel, oldest first, with the LIVE FILE APPENDED LAST.
  //
  // The trailing live entry is not decoration: the editor treats the highest
  // ordinal as "current" (`EditorController.php:930-940`,
  // `editor.js:728-745` derives currentVersion as the array maximum). Omitting
  // it yields a panel that looks right and behaves wrongly — the newest past
  // revision would be presented as the document's present state.
  async history(user: UserModel, space: SpaceEnv): Promise<EditorHistoryEntry[]> {
    const rows = await this.ascending(user, space)
    return [...rows.map((row, index) => this.entryFor(row, index + 1)), await this.liveEntry(space, rows.length + 1, rows.at(-1))]
  }

  // Render inputs for ONE ordinal. `officeToken` is the caller's own
  // TOKEN_TYPE.ONLY_OFFICE JWT, which ends up in the returned `url` — see
  // documentServerUrl for why it is required and verified rather than minted.
  async versionData(user: UserModel, space: SpaceEnv, ordinal: number, officeToken: string): Promise<EditorVersionData> {
    await this.requireOwnOfficeToken(user, officeToken)
    const rows = await this.ascending(user, space)
    // Bare extension, lowercased, no dot — `EditorController.php:1036`.
    const fileType = path.extname(space.realPath).slice(1).toLowerCase()

    if (ordinal === rows.length + 1) {
      return this.signed({
        fileType,
        // The live file is served by the EXISTING onlyoffice document route,
        // which is what the running editor session is already reading. A second
        // route serving the same bytes would be a second thing to keep
        // authorized.
        url: this.documentServerUrl(API_ONLY_OFFICE_DOCUMENT, space, officeToken),
        version: ordinal,
        key: await this.liveDocumentKey(space)
      })
    }

    const row = this.requireRow(rows, ordinal)
    return this.signed({
      fileType,
      url: this.documentServerUrl(`${API_VERSIONS_EDITOR_CONTENT}/${row.id}`, space, officeToken),
      version: ordinal,
      key: this.revisionId(row)
    })
  }

  // Restores the ordinal and returns the REFRESHED history, so the editor's
  // `onRequestRestore` can hand the result straight to `refreshHistory`
  // (`editor.js:254-259`, and upstream's own restore returns `history($fileId)`
  // — `EditorController.php:1127`).
  //
  // Restore itself is NOT reimplemented here. VersioningService.restoreVersion is
  // where the pinned-descriptor rule (ADR §9 / invariant 3), the
  // createOrRefresh lock rule, and the OnlyOffice document-key invalidation
  // (invariant 7, #378) all live — and it is that last one which makes an
  // in-editor restore visible at all, rather than the document server re-serving
  // its own cached copy under an unchanged key.
  async restore(user: UserModel, space: SpaceEnv, ordinal: number): Promise<EditorHistoryEntry[]> {
    const rows = await this.ascending(user, space)
    // The live ordinal is a no-op rather than an error: it is "restore the state
    // the file is already in". Upstream ignores it the same way
    // (`EditorController.php:1118` only rolls back when the ordinal is in range),
    // and the editor never offers Restore on the current entry. Anything BEYOND
    // it still 404s — see requireRow.
    if (ordinal !== rows.length + 1) {
      await this.versioning.restoreVersion(user, space, this.requireRow(rows, ordinal).id)
    }
    return this.history(user, space)
  }

  /* ------------------------------------------------------------- internals */

  // ASCENDING, which is the reverse of what the domain returns: listByFileId
  // orders `desc(createdAt), desc(id)` (versioning-queries.service.ts:55) because
  // every other consumer wants newest-first, while the panel's ordinal 1 is the
  // OLDEST revision (upstream reverses for the same reason —
  // `FileVersions::processVersionsArray` is `array_reverse`).
  //
  // Copied before reversing: listVersions hands back a fresh array today, but a
  // caller that mutates a value it did not create is one refactor away from
  // reversing someone else's list.
  private async ascending(user: UserModel, space: SpaceEnv): Promise<VersionProps[]> {
    return [...(await this.versioning.listVersions(user, space))].reverse()
  }

  private entryFor(row: VersionProps, ordinal: number): EditorHistoryEntry {
    return {
      // Rows hold MILLISECONDS; the editor multiplies by 1000
      // (`editor.js:735`). Without the divide every entry in the panel is dated
      // to 1970.
      created: Math.floor(row.mtime / 1000),
      key: this.revisionId(row),
      version: ordinal,
      // Omitted rather than defaulted — see EditorHistoryEntry.user for why we
      // diverge from upstream's fall-back-to-owner here.
      ...(row.author && { user: { id: row.author.login, name: row.author.fullName } })
    }
  }

  // `${fileId}_${versionId}`, and NOT the content checksum, for two independent
  // reasons (design §3). Upstream runs every key through
  // `DocumentService::generateRevisionId`, which crc32s anything longer than 20
  // characters — our sha512-256 checksums are 64. And the blob store DEDUPS, so
  // two versions with identical bytes share a checksum: the panel would show two
  // rows the document server treated as one document.
  //
  // Both parts are needed. The row id alone is unique, but pairing it with the
  // file id keeps the revision id meaningful in a document-server cache that is
  // shared across every file on the instance.
  private revisionId(row: VersionProps): string {
    return `${row.fileId}_${row.id}`
  }

  // The live file as a history entry.
  //
  // `newest` is the most recent version row, and it is what names the live
  // entry's author. That is not a borrow from the wrong place: `snapshot`
  // records `authorId = user.id` for the user performing the OVERWRITE
  // (versioning.service.ts:168), so a row holds the bytes that were REPLACED
  // while naming the person who replaced them — and the newest row therefore
  // names whoever wrote the content that is live now.
  //
  // Omitted when that row has no author, or when there is no row at all. The
  // panel renders a missing user as "Anonymous" (`version.user.name ||
  // this.textAnonymous`, web-apps documenteditor Main.js:764), which is the
  // honest rendering of "we do not know" — but it must not be the rendering of
  // the CURRENT version in a session the user is sitting in, which is what
  // omitting this unconditionally produced.
  private async liveEntry(space: SpaceEnv, ordinal: number, newest?: VersionProps): Promise<EditorHistoryEntry> {
    const stats = await fs.stat(space.realPath).catch(() => null)
    if (!stats?.isFile()) {
      throw new FileError(HttpStatus.NOT_FOUND, 'Location not found')
    }
    return {
      created: Math.floor(stats.mtimeMs / 1000),
      key: await this.liveDocumentKey(space),
      version: ordinal,
      ...(newest?.author && { user: { id: newest.author.login, name: newest.author.fullName } })
    }
  }

  // The document key of the live content — the key the running editor session is
  // already using, read from the cache OnlyOfficeManager.getDocumentKey wrote
  // when it answered /settings.
  //
  // Read rather than asked, for the reason only-office-doc-key.ts documents: the
  // manager is provided conditionally and already depends on VersioningService.
  // On a cache miss the value is COMPUTED with the manager's own expression
  // instead of being cached here — writing it would fabricate a session key for
  // a session that does not exist.
  private async liveDocumentKey(space: SpaceEnv): Promise<string> {
    const cached: string = await this.cache.get(onlyOfficeDocKeyCacheKey(space.dbFile))
    return cached || genEtag(null, space.realPath, false)
  }

  // An ABSOLUTE url the document server can fetch, built the way
  // OnlyOfficeManager.buildUrl builds one
  // (only-office-manager.service.ts:258-262).
  //
  // Absolute because the fetch is server-to-server, and `headerOriginUrl()` —
  // not a configured hostname — because that is what is correct behind the
  // reverse proxy. It is populated by ContextInterceptor, so EVERY route calling
  // into here needs that interceptor; without it this silently produces
  // `undefined/...`.
  private documentServerUrl(basePath: string, space: SpaceEnv, officeToken: string): string {
    const url = new URL(`${basePath}/${encodeUrl(space.url)}`, this.contextManager.headerOriginUrl())
    url.searchParams.set(ONLY_OFFICE_TOKEN_QUERY_PARAM_NAME, officeToken)
    return url.toString()
  }

  // The caller's own ONLY_OFFICE token, verified.
  //
  // Why the token is LIFTED from the caller instead of minted here: the frontend
  // already holds one — it arrives inside `config.document.url`'s query string
  // when the editor fetches its settings — and OnlyOfficeManager.genAuthToken is
  // private, so minting a second one would mean modifying an upstream file to
  // expose a signing site that already exists. Echoing the caller's is strictly
  // less surface than adding a second one.
  //
  // Verified rather than echoed blind for two reasons. A malformed token would
  // otherwise produce a URL the document server 401s on, and the symptom — an
  // empty panel — points nowhere near the cause. And requiring the token to name
  // the CALLER removes any need to reason about what happens when someone pastes
  // a token belonging to another account.
  private async requireOwnOfficeToken(user: UserModel, officeToken: string): Promise<void> {
    let payload: JwtPayload
    try {
      payload = await this.jwt.verifyAsync(officeToken, { secret: configuration.auth.token.access.secret })
    } catch {
      throw new FileError(HttpStatus.BAD_REQUEST, 'Invalid editor token')
    }
    if (payload.tokenType !== TOKEN_TYPE.ONLY_OFFICE || payload.identity?.id !== user.id) {
      throw new FileError(HttpStatus.FORBIDDEN, 'Editor token does not belong to this session')
    }
  }

  // Signs the WHOLE response, and only when a secret is configured.
  //
  // The document server validates this through `fillVersionHistoryFromJwt`
  // (`DocsCoServer.js:2874`) and REJECTS an unsigned response rather than
  // ignoring the signature — so an unsigned reply is not a degraded panel, it is
  // a panel that opens and renders nothing. The converse is equally true, which
  // is why an absent secret means no token at all: a document server started
  // without JWT_SECRET rejects a signed payload.
  //
  // `iat`/`exp` go into the BODY and are then signed, so body and token claims
  // are identical (`EditorController.php:1065-1071`). jsonwebtoken preserves a
  // payload's own `iat`/`exp` when `expiresIn` is not passed, which is why it is
  // not.
  private async signed(result: EditorVersionData): Promise<EditorVersionData> {
    const secret = activeOfficeEditorSecret()
    if (!secret) return result
    const iat = Math.floor(Date.now() / 1000)
    const payload = { ...result, iat, exp: iat + EDITOR_VERSION_TOKEN_TTL_SECONDS }
    return { ...payload, token: await this.jwt.signAsync(payload, { secret }) }
  }

  // Maps an ordinal to a row, or refuses.
  //
  // Upstream reads ANY ordinal above the version count as "the live file"
  // (`EditorController.php:1021`), so version 9999 of a two-version file
  // silently answers with the current document. We refuse instead: the editor
  // only ever sends ordinals it was given, so an out-of-range one is a bug or a
  // probe, and answering it with real content would be answering a question
  // nobody legitimately asked. The live ordinal itself is handled before this is
  // reached.
  private requireRow(rows: VersionProps[], ordinal: number): VersionProps {
    const row = Number.isSafeInteger(ordinal) && ordinal >= 1 ? rows[ordinal - 1] : undefined
    if (!row) {
      throw new FileError(HttpStatus.NOT_FOUND, 'Version not found')
    }
    return row
  }
}

// Matches the 60 s OnlyOfficeManager.genPayloadToken uses for the editor config
// it signs at the same origin — the document server fetches a version response
// immediately after receiving it, so a long life buys nothing and widens replay.
const EDITOR_VERSION_TOKEN_TTL_SECONDS = 60
