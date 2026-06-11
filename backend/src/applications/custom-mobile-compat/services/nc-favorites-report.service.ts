import { HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { FastifyReply } from 'fastify'
import { XMLBuilder } from 'fast-xml-parser'
import path from 'node:path'
import { encodeUrl } from '../../../common/shared'
import { getProps } from '../../files/utils/files'
import { FavoritesManager } from '../../custom-favorites/services/favorites-manager.service'
import { SpacesManager } from '../../spaces/services/spaces-manager.service'
import { UserModel } from '../../users/models/user.model'
import { XML_CONTENT_TYPE } from '../../webdav/constants/webdav'
import { FastifyDAVRequest } from '../../webdav/interfaces/webdav.interface'
import { WebDAVFile } from '../../webdav/models/webdav-file.model'
import '../interfaces/nc-request.interface'
import { buildNcPropResponse } from '../utils/nc-prop-builder'
import { ncSubpathForFavorite } from '../utils/nc-favorites-xml'
import { NcPathResolverService } from './nc-path-resolver.service'
import { NcShareMountResolverService } from './nc-share-mount-resolver.service'

// Nextcloud favorites on the WebDAV surface — the two verbs the stock NC
// iOS/Android clients use beyond the PROPFIND star (which lives in
// nc-prop-builder + nc-propfind.service):
//
//   REPORT <oc:filter-files>  → list the user's favorites (Favorites tab)
//   PROPPATCH <oc:favorite>   → toggle a single file's favorite state
//
// Both reuse FavoritesManager verbatim — the same service the v2 UI and the
// classic /api/app/favorites endpoints drive — so the NC surface never drifts
// from the web surface. See docs/plans/2026-06-11-nc-favorites-design.md.

const XMLNS = {
  d: 'DAV:',
  oc: 'http://owncloud.org/ns',
  nc: 'http://nextcloud.org/ns',
  ocs: 'http://open-collaboration-services.org/ns'
}

const NC_FILES_URL_PREFIX = '/remote.php/dav/files'

@Injectable()
export class NcFavoritesReportService {
  private readonly logger = new Logger(NcFavoritesReportService.name)
  private readonly xml = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    format: false,
    suppressEmptyNode: false
  })

  constructor(
    private readonly favorites: FavoritesManager,
    private readonly resolver: NcPathResolverService,
    private readonly shareMounts: NcShareMountResolverService,
    private readonly spacesManager: SpacesManager
  ) {}

  // REPORT <oc:filter-files> — list the favorites reachable under the user's
  // NC home. "Home-reachable only": a favorite is emitted only if its stored
  // repository path maps to a navigable href under the current home (personal
  // + mounted shares, plus the space when mobileHome points at it). Out-of-home
  // favorites are silently omitted so we never emit a <d:href> the client
  // can't follow. NextcloudKit parses the response with the same multistatus
  // parser used for PROPFIND, so the per-entry shape is byte-identical.
  async respond(req: FastifyDAVRequest, res: FastifyReply): Promise<FastifyReply> {
    const user = req.user as UserModel | undefined
    if (!user) {
      throw new HttpException('User not attached to request', HttpStatus.INTERNAL_SERVER_ERROR)
    }

    const favs = await this.favorites.getFavorites(user)
    const home = this.resolver.resolve(user, { mode: 'files', subpath: '' })
    // Share-mounts overlay every NC home root; a missing mount listing degrades
    // to "no share favorites" rather than failing the whole REPORT.
    let mounts: Awaited<ReturnType<typeof this.shareMounts.listMounts>> = []
    try {
      mounts = await this.shareMounts.listMounts(user)
    } catch (e) {
      this.logger.warn({ tag: this.respond.name, msg: `share-mount listing failed (degrading to no share favorites): ${(e as Error).message}` })
    }

    const responses: unknown[] = []
    for (const fav of favs) {
      const ncSub = ncSubpathForFavorite(fav.navPath, { spaceAlias: home.spaceAlias, rootAlias: home.rootAlias }, mounts)
      if (ncSub === null) continue // not reachable under this home — omit

      // navPath IS the spaceEnv segment list ([repository, alias, ...path]) —
      // the same shape SpacesManager.spaceEnv consumes — so resolve straight
      // from it rather than rebuilding from the home-relative ncSub.
      const segments = fav.navPath.split('/').filter(Boolean)
      let space
      try {
        space = await this.spacesManager.spaceEnv(user, segments)
      } catch (e) {
        this.logger.warn({ tag: this.respond.name, msg: `spaceEnv failed for favorite ${fav.navPath}: ${(e as Error).message}` })
        continue
      }

      let props
      try {
        props = await getProps(space.realPath, space.relativeUrl)
      } catch (e) {
        // File gone from disk (favorite row outlived the file) — skip rather
        // than emit a phantom entry the client would fail to open.
        this.logger.debug({ tag: this.respond.name, msg: `stat failed for favorite ${fav.navPath}: ${(e as Error).message}` })
        continue
      }

      // Mirror buildEventResponse's href construction: pass the unencoded
      // parent URL to WebDAVFile, which encodeUrl-encodes once.
      const urlFilePath = `${NC_FILES_URL_PREFIX}/${user.login}/${ncSub}`
      const file = new WebDAVFile(props, path.posix.dirname(urlFilePath))
      file.id = fav.id
      responses.push(
        buildNcPropResponse(
          file,
          space,
          'files',
          false,
          user.fullName,
          undefined,
          { login: user.login, displayName: user.fullName || user.login },
          true
        )
      )
    }

    return this.send(res, responses)
  }

  // PROPPATCH <oc:favorite> on a file's own DAV URL. The caller has already
  // classified the body (parseFavoriteProppatch) and resolved req.space to the
  // target file. We toggle via FavoritesManager and echo a 207 multistatus.
  // Upstream NC returns 200 on set and 204 on remove (TagsPlugin.php) — we
  // mirror that in the per-prop status. Unfavorite is idempotent: a file that
  // wasn't favorited (removeFavorite throws NotFound) still returns success.
  async respondProppatchFavorite(req: FastifyDAVRequest, res: FastifyReply, favorite: boolean): Promise<FastifyReply> {
    const user = req.user as UserModel | undefined
    const space = req.space
    if (!user || !space) {
      throw new HttpException('User or space not attached to request', HttpStatus.INTERNAL_SERVER_ERROR)
    }

    if (favorite) {
      await this.favorites.addFavorite(user, space)
    } else {
      try {
        await this.favorites.removeFavorite(user, space)
      } catch (e) {
        if (!(e instanceof NotFoundException)) throw e
        // already not favorited — idempotent success
      }
    }

    const href = encodeUrl(req.dav?.url ?? `${NC_FILES_URL_PREFIX}/${user.login}/${space.relativeUrl ?? ''}`)
    const status = favorite ? 'HTTP/1.1 200 OK' : 'HTTP/1.1 204 No Content'
    const response = {
      'd:href': href,
      'd:propstat': {
        'd:prop': { 'oc:favorite': '' },
        'd:status': status
      }
    }
    return this.send(res, [response])
  }

  private send(res: FastifyReply, responses: unknown[]): FastifyReply {
    const root: Record<string, unknown> = {
      '@_xmlns:d': XMLNS.d,
      '@_xmlns:oc': XMLNS.oc,
      '@_xmlns:nc': XMLNS.nc,
      '@_xmlns:ocs': XMLNS.ocs
    }
    if (responses.length > 0) root['d:response'] = responses
    const body = this.xml.build({ 'd:multistatus': root })
    return res.type(XML_CONTENT_TYPE).status(HttpStatus.MULTI_STATUS).send(`<?xml version="1.0" encoding="utf-8"?>${body}`)
  }
}
