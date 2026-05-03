import { Inject, Injectable, Logger } from '@nestjs/common'
import { inArray } from 'drizzle-orm'
import { FastifyReply } from 'fastify'
import { XMLBuilder } from 'fast-xml-parser'
import { DB_TOKEN_PROVIDER } from '../../../infrastructure/database/constants'
import { DBSchema } from '../../../infrastructure/database/interfaces/database.interface'
import { File } from '../../files/schemas/file.interface'
import { files } from '../../files/schemas/files.schema'
import { FilesRecents } from '../../files/services/files-recents.service'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { UserModel } from '../../users/models/user.model'
import { WebDAVFile } from '../../webdav/models/webdav-file.model'
import { buildNcPropResponse } from '../utils/nc-prop-builder'
import { type SearchBody, parseSearchBody } from '../utils/nc-search-body'
import { NcPathResolverService } from './nc-path-resolver.service'

// Handles WebDAV `SEARCH /remote.php/dav` from NextcloudKit's
// `searchBodyRequestAsync`. Today we only recognize the "Recent" body shape
// (NCRecent.swift::requestBodyRecent — date-filter + sort-by-mtime + limit).
// Anything else returns an empty 207 multistatus so iOS doesn't logout-on-5xx.
//
// Implementation strategy:
//   1. Parse the body. Reject unknown shapes by emitting an empty 207.
//   2. Resolve the user's NC home (NcPathResolverService) — same path used by
//      PROPFIND. Recents outside that home would 404 on tap.
//   3. Pull recents via FilesRecents.getRecents (the same 14-day rolling
//      table that powers the classic Recents widget and our /recommendations
//      endpoint). Filter to home-prefix matches.
//   4. Bulk-fetch full `files` rows by id so we have ctime / size / etc. for
//      the PROPFIND-shaped <d:response> entries.
//   5. Render via the same buildNcPropResponse used by PROPFIND so the wire
//      shape is byte-identical (etag form, has-preview text, permission
//      letters) — anything else risks NK choking.
//
// The handler never throws. Bug-class 5xx → iOS interprets as auth failure
// and forces the user to re-login (the user-facing report behind this PR).
@Injectable()
export class NcSearchService {
  private readonly logger = new Logger(NcSearchService.name)
  private readonly xml = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    format: false,
    suppressEmptyNode: false
  })

  constructor(
    @Inject(DB_TOKEN_PROVIDER) private readonly db: DBSchema,
    private readonly filesRecents: FilesRecents,
    private readonly pathResolver: NcPathResolverService
  ) {}

  async respond(user: UserModel, body: string | Buffer | null | undefined, res: FastifyReply): Promise<FastifyReply> {
    let responses: Record<string, unknown>[] = []
    try {
      const parsed = parseSearchBody(body)
      if (parsed.kind === 'recent') {
        responses = await this.buildRecentResponses(user, parsed)
      }
      // 'unknown' → empty multistatus. Cheap and safe — see class comment.
    } catch (e) {
      // Last-resort backstop. We deliberately swallow rather than 5xx because
      // NC iOS treats 5xx on this path as a sign of a broken session and
      // logs the user out. An empty carousel beats forced re-login.
      this.logger.error({ tag: 'respond', msg: `nc-search failed: ${(e as Error).message}` })
      responses = []
    }
    return this.renderMultistatus(res, responses)
  }

  private async buildRecentResponses(user: UserModel, parsed: Extract<SearchBody, { kind: 'recent' }>): Promise<Record<string, unknown>[]> {
    // Cross-check the body's scope.href against the authenticated user. The
    // scope field comes from the client; an attacker who replayed someone
    // else's Basic Auth token could craft a SEARCH for a different user.
    // Sync-in's getRecents(user, …) already filters server-side by user.id,
    // so the worst case is a no-op, but reject mismatches up-front to make
    // the intent explicit (and to keep the log line clean if it ever fires).
    const expectedScope = `/files/${user.login}`
    if (parsed.scopeHref !== expectedScope && parsed.scopeHref !== expectedScope + '/') {
      this.logger.warn({ tag: 'buildRecentResponses', msg: `scope mismatch: body=${parsed.scopeHref} user=${user.login}` })
      return []
    }

    const homePrefix = this.pathResolver.toInternalPath(this.pathResolver.resolve(user, { mode: 'files', subpath: '' }))
    const recents = await this.filesRecents.getRecents(user, parsed.limit)
    const inHome = recents.filter((r) => isUnderHome(r.path, homePrefix))
    if (!inHome.length) return []

    const ids = inHome.map((r) => r.id).filter((id) => Number.isFinite(id) && id > 0)
    if (!ids.length) return []
    const fileRows = await this.db.select().from(files).where(inArray(files.id, ids))
    const byId = new Map<number, File>(fileRows.map((row) => [row.id, row as File]))

    const fakeSpace = personalSpacePlaceholder()
    const requesterFallback = { login: user.login, displayName: user.fullName || user.login }
    const userHomeHref = `/remote.php/dav/files/${user.login}`

    const out: Record<string, unknown>[] = []
    for (const r of inHome) {
      const row = byId.get(r.id)
      if (!row || row.isDir) continue // dropped between recents and lookup, or directory (we only emit files)
      const ncRelDir = computeNcRelDir(r.path, homePrefix)
      const parentHref = ncRelDir === '/' ? userHomeHref : `${userHomeHref}${ncRelDir}`
      const webdavFile = new WebDAVFile(
        {
          id: row.id,
          name: r.name,
          isDir: false,
          size: row.size ?? 0,
          ctime: row.ctime ?? row.mtime ?? 0,
          mtime: row.mtime ?? r.mtime ?? 0,
          mime: row.mime ?? r.mime ?? ''
        },
        parentHref,
        false
      )
      out.push(buildNcPropResponse(webdavFile, fakeSpace, 'files', false, requesterFallback.displayName, undefined, requesterFallback))
    }
    return out
  }

  private renderMultistatus(res: FastifyReply, responses: Record<string, unknown>[]): FastifyReply {
    const body = this.xml.build({
      'd:multistatus': {
        '@_xmlns:d': 'DAV:',
        '@_xmlns:oc': 'http://owncloud.org/ns',
        '@_xmlns:nc': 'http://nextcloud.org/ns',
        '@_xmlns:ocs': 'http://open-collaboration-services.org/ns',
        'd:response': responses
      }
    })
    return res.header('Content-Type', 'application/xml; charset=utf-8').status(207).send(`<?xml version="1.0" encoding="utf-8"?>${body}`)
  }
}

// True when `recentPath` is the home root or strictly nested below it. The
// trailing-slash check prevents `files/personal-archive` from matching
// `files/personal`.
function isUnderHome(recentPath: string, homePrefix: string): boolean {
  return recentPath === homePrefix || recentPath.startsWith(homePrefix + '/')
}

// Strip the home prefix from a Sync-in storage path (e.g. `files/personal/Documents`
// → `/Documents`). Root → `/`. Mirrors nc-recommendation-entry's equivalent
// helper, kept private here to avoid coupling the two callers.
function computeNcRelDir(recentPath: string, homePrefix: string): string {
  if (recentPath === homePrefix) return '/'
  if (recentPath.startsWith(homePrefix + '/')) return '/' + recentPath.slice(homePrefix.length + 1)
  return '/'
}

// Synthetic SpaceEnv stand-in good enough for buildNcPropResponse on
// personal-space files. The prop builder reads `envPermissions ||
// permissions` for the letter set and `root?.owner` for the owner; we leave
// `root` unset so the requester fallback path fires (PR #139's owner-id fix).
//
// `'a:d:m:si:so'` is the Sync-in personal-space full-control perm string;
// `toNcPermissions` translates it to NC letters `GRDNVW` for files.
function personalSpacePlaceholder(): SpaceEnv {
  const PERSONAL_PERMS = 'a:d:m:si:so'
  return {
    envPermissions: PERSONAL_PERMS,
    permissions: PERSONAL_PERMS,
    root: undefined,
    url: ''
  } as unknown as SpaceEnv
}

// Re-export for the test file.
export const __test__ = { isUnderHome, computeNcRelDir, personalSpacePlaceholder }
