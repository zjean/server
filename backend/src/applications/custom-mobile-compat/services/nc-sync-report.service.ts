import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common'
import { FastifyReply } from 'fastify'
import path from 'node:path'
import { FileProps } from '../../files/interfaces/file-props.interface'
import { getProps } from '../../files/utils/files'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { UserModel } from '../../users/models/user.model'
import { XML_CONTENT_TYPE } from '../../webdav/constants/webdav'
import { FastifyDAVRequest } from '../../webdav/interfaces/webdav.interface'
import { WebDAVFile } from '../../webdav/models/webdav-file.model'
import { FavoritesManager } from '../../custom-favorites/services/favorites-manager.service'
import { buildNcDeletedResponse, buildNcPropResponse } from '../utils/nc-prop-builder'
import { formatSyncToken, parseSyncCollectionBody, type ParsedSyncCollection } from '../utils/nc-sync-xml'
import { renderMultistatus } from '../utils/nc-xml'
import { NcFileRowEnsurer } from './nc-file-row-ensurer.service'
import { NcSyncEvent, NcSyncLogService } from './nc-sync-log.service'

// Handles WebDAV REPORT requests carrying a <d:sync-collection> body
// (RFC 6578). Asks NcSyncLogService for events newer than the client's
// sync-token, stats each create/update event off disk, and emits a
// 207 Multi-Status response with one <d:response> per event plus a
// trailing <d:sync-token> the client uses next time.
//
// Scope (v1): events are filtered to the requesting user's id AND the
// SpaceEnv alias resolved from the URL — typically `personal` when iOS hits
// /remote.php/dav/files/<user>/. Cross-space sync (events from a shared
// space showing up at the user-root URL) is a phase-2-follow-up; for the
// initial NC mobile sync we only need personal-space deltas.

const NC_FILES_URL_PREFIX = '/remote.php/dav/files'

// Cap any client-supplied <d:limit> to keep a single REPORT response
// bounded. NC iOS sends 500 in practice; we cap at the same value.
const MAX_LIMIT = 500

@Injectable()
export class NcSyncReportService {
  private readonly logger = new Logger(NcSyncReportService.name)

  constructor(
    private readonly syncLog: NcSyncLogService,
    private readonly fileRowEnsurer: NcFileRowEnsurer,
    private readonly favorites: FavoritesManager
  ) {}

  async respond(req: FastifyDAVRequest, res: FastifyReply): Promise<FastifyReply> {
    const space = req.space
    const user = req.user as UserModel | undefined
    if (!space || !user) {
      throw new HttpException('Space or user not attached to request', HttpStatus.INTERNAL_SERVER_ERROR)
    }
    if (space.inTrashRepository) {
      // sync-collection on the trashbin URL is unusual; NC iOS doesn't
      // currently REPORT trashbin. Refuse with 405 so an unexpected client
      // surfaces, rather than silently lying with an empty response.
      throw new HttpException('REPORT not supported on trashbin', HttpStatus.METHOD_NOT_ALLOWED)
    }

    let parsed: ParsedSyncCollection
    try {
      parsed = parseSyncCollectionBody(req.body as string | Buffer | null | undefined)
    } catch (e) {
      throw new HttpException(`Invalid sync-collection body: ${(e as Error).message}`, HttpStatus.BAD_REQUEST)
    }

    // Prune-horizon check: if the client's last-seen token is older than
    // the oldest event we still keep, we no longer have the deltas to
    // catch them up. RFC 6578 §3.2 says the server returns 412 in that
    // case so the client wipes its local cache and does a fresh sync.
    if (parsed.sinceId > 0) {
      const minKept = await this.syncLog.minKeptToken()
      if (minKept > 0 && parsed.sinceId < minKept) {
        throw new HttpException('sync-token too old; full re-sync required', HttpStatus.PRECONDITION_FAILED)
      }
    }

    const limit = Math.min(parsed.limit ?? MAX_LIMIT, MAX_LIMIT)
    const events = await this.syncLog.since({
      ownerId: user.id,
      sinceId: parsed.sinceId,
      spaceAlias: space.alias,
      limit
    })

    // Empty response: echo the same token back so the client knows it's
    // up to date. The trailing <d:sync-token> still has to be the URN form
    // — passing the raw `since` integer would break clients who validate
    // the URN prefix.
    if (events.length === 0) {
      return this.send(res, [], parsed.sinceId)
    }

    // Dedupe by path keeping the latest event — RFC 6578 §3.6: "the server
    // SHOULD NOT report the same resource more than once". Without this a
    // create + later delete in the same window would produce two responses
    // for the same href, confusing the client's local merge. `since()` already
    // scopes the query to a single spaceAlias (WHERE eq), so path alone is a
    // unique key here — this mirrors upstream NC's CardDavBackend dedup
    // (`$changes[$row['uri']]`, keyed on the path/uri field alone, with the
    // collection dimension pushed into the SQL WHERE rather than into the key).
    // RFC 6578 §3.1: sync-collection is anchored at the URL the REPORT was
    // sent to. If the URL resolves to a subfolder of the space, drop events
    // outside that subtree. NC iOS REPORTs at user-root in practice — this
    // is a defensive filter for any client that REPORTs a subpath instead.
    // newSyncToken is still derived from the full `events` window below, so
    // the client advances past out-of-subtree events and doesn't re-fetch
    // them on the next refresh.
    const inScope = scopeEventsToSubtree(events, space.relativeUrl)

    const latest = new Map<string, NcSyncEvent>()
    for (const e of inScope) {
      latest.set(e.path, e)
    }

    // Favorite-id set, fetched once. Threaded into each create/update response
    // so a synced file keeps its star — without it, PROPFIND emits oc:favorite=1
    // but the next sync-collection emits 0 and iOS toggles the star off locally.
    // Degrades to "no stars" on lookup failure rather than failing the REPORT.
    let favoriteIds = new Set<number>()
    try {
      favoriteIds = new Set(await this.favorites.getFavoriteIds(user))
    } catch (err) {
      this.logger.warn({ tag: this.respond.name, msg: `favorite-id lookup failed (degrading to no stars): ${(err as Error).message}` })
    }

    const responses: unknown[] = []
    for (const event of latest.values()) {
      try {
        const r = await this.buildEventResponse(event, user, space, favoriteIds)
        if (r) responses.push(r)
      } catch (err) {
        this.logger.warn({
          tag: this.respond.name,
          msg: `failed to build response for event ${event.id} (${event.path}): ${(err as Error).message}`
        })
      }
    }

    // newSyncToken = the highest event id in this batch — clients use it
    // to resume from after this exact response. Always derive from the
    // RAW event window (not the deduped map) so a deleted-then-created
    // file still advances the token past its delete event.
    const newSyncToken = events[events.length - 1].id
    return this.send(res, responses, newSyncToken)
  }

  // The REPORT <oc:filter-files> body (NC iOS/Android Favorites tab) is routed
  // by NcDavController to NcFavoritesReportService — favorites now have real
  // per-user storage (custom-favorites), so the listing lives there rather
  // than the empty stub this service used to carry.

  private async buildEventResponse(
    event: NcSyncEvent,
    user: UserModel,
    space: SpaceEnv,
    favoriteIds: Set<number>
  ): Promise<Record<string, unknown> | null> {
    const href = `${NC_FILES_URL_PREFIX}/${encodeUriUserPath(user.login, event.path)}`

    if (event.type === 'delete') {
      return buildNcDeletedResponse(href)
    }

    // Defensive: empty path can't be stat'd. Skip silently — phase-1
    // emitted these for the rPath-equals-realPath bug; fixed now but kept
    // tolerant in case a stale row leaks through from a pre-fix deploy.
    if (!event.path) return null

    // create / update — stat the file off disk. If the file no longer
    // exists (created then deleted within the window, but our latest
    // dedup'd event was the create — possible if the delete event hasn't
    // been logged yet for some race-y reason), fall back to a delete
    // response so the client doesn't end up with a phantom entry.
    const realFilePath = path.join(space.realBasePath, event.path)
    const urlFilePath = `${NC_FILES_URL_PREFIX}/${user.login}/${event.path}`
    let props: FileProps
    try {
      // Pass event.path (in-space relative) — not urlFilePath — so props.path
      // matches the DB convention (path-relative-to-space, like 'Documents'
      // or '.' for root). This mirrors spaces-browser.service.ts:144 and is
      // load-bearing: getSpaceFileId(props, dbFile) builds a WHERE on
      // files.path, so feeding it the URL form would never match a real row.
      props = await getProps(realFilePath, event.path)
    } catch (e) {
      this.logger.debug({ tag: this.buildEventResponse.name, msg: `stat failed for ${realFilePath}: ${(e as Error).message}` })
      return buildNcDeletedResponse(href)
    }
    // Use the same get-or-create logic as PROPFIND (NcFileRowEnsurer) so REPORT
    // always emits a stable real DB id. The old read-only resolveDbId returned
    // the inode placeholder when no DB row existed yet, causing NC iOS to cache
    // that placeholder as the file's primary key; the next PROPFIND would then
    // emit the real DB id and iOS would show the file twice.
    const currentUrl = path.posix.dirname(urlFilePath)
    const file = new WebDAVFile(props, currentUrl)
    file.id = await this.fileRowEnsurer.ensure(file, space, user)
    // REPORT events always describe files in the requester's own space,
    // so the file owner == the requester — pass their fullName for the
    // <oc:owner-display-name> field, and the same identity as the
    // requester fallback so personal-space synthetic roots without an
    // explicit owner still emit a non-empty <oc:owner-id> (NC Android
    // gates canCreate on owner-id == self).
    return buildNcPropResponse(
      file,
      space,
      'files',
      false,
      user.fullName,
      undefined,
      {
        login: user.login,
        displayName: user.fullName || user.login
      },
      favoriteIds.has(file.id)
    )
  }

  private send(res: FastifyReply, responses: unknown[], syncTokenSeq: number): FastifyReply {
    // <d:sync-token> goes LAST, after the responses — RFC 6578 §6.4. `trailing`
    // is what guarantees that ordering now that the envelope is shared.
    const body = renderMultistatus(responses, { trailing: { 'd:sync-token': formatSyncToken(syncTokenSeq) } })
    return res.type(XML_CONTENT_TYPE).status(HttpStatus.MULTI_STATUS).send(body)
  }
}

function encodeUriUserPath(login: string, eventPath: string): string {
  // login + each path segment is URL-encoded, then rejoined with '/'.
  const parts = [login, ...eventPath.split('/').filter(Boolean)]
  return parts.map((p) => encodeURIComponent(p)).join('/')
}

// Keep only events whose path equals the in-space relativeUrl (the REPORT
// URL anchor itself) or lies under it. '.' / '' / null mean "at space root"
// — every event passes. Uses a trailing-slash prefix so a sibling whose name
// starts with the same characters (e.g. 'DocumentsBackup' vs 'Documents')
// doesn't sneak in via a naive startsWith match.
function scopeEventsToSubtree(events: NcSyncEvent[], relativeUrl: string | undefined): NcSyncEvent[] {
  if (!relativeUrl || relativeUrl === '.') return events
  const prefix = `${relativeUrl}/`
  return events.filter((e) => e.path === relativeUrl || e.path.startsWith(prefix))
}

// Re-export so unit tests can poke without going through NcSyncReportService.
export { encodeUriUserPath as encodeUriUserPathForTest, MAX_LIMIT, NC_FILES_URL_PREFIX, scopeEventsToSubtree as scopeEventsToSubtreeForTest }
