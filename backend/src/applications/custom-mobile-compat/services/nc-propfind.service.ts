import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common'
import { FastifyReply } from 'fastify'
import { XMLBuilder } from 'fast-xml-parser'
import { SPACE_REPOSITORY } from '../../spaces/constants/spaces'
import { UserModel } from '../../users/models/user.model'
import { DEPTH, XML_CONTENT_TYPE } from '../../webdav/constants/webdav'
import { FastifyDAVRequest } from '../../webdav/interfaces/webdav.interface'
import { WebDAVSpaces } from '../../webdav/services/webdav-spaces.service'
import { FavoritesManager } from '../../custom-favorites/services/favorites-manager.service'
import '../interfaces/nc-request.interface'
import { buildNcPropResponse } from '../utils/nc-prop-builder'
import { type NcPermissionsMode } from '../utils/nc-permissions'
import { buildShareMountPropResponse, rawurlencodeSegment } from '../utils/nc-share-mount-response'
import { NcFileRowEnsurer } from './nc-file-row-ensurer.service'
import { NcShareMountResolverService } from './nc-share-mount-resolver.service'

// Nextcloud clients expect four namespaces on every <d:multistatus>:
//   d   — DAV:                                        (lowercase prefix, NC convention)
//   oc  — http://owncloud.org/ns                      (fileid, permissions, owner-*, ...)
//   nc  — http://nextcloud.org/ns                     (has-preview, trashbin-*, mount-type)
//   ocs — http://open-collaboration-services.org/ns   (share-permissions bitmask)
//
// Sync-in's native WebDAV only declares DAV: (via an uppercase "D:" prefix,
// which NC clients don't parse), so PROPFIND responses for stock mobile
// clients are built here from scratch rather than delegated to
// WebDAVMethods.propfind.

const XMLNS = {
  d: 'DAV:',
  oc: 'http://owncloud.org/ns',
  nc: 'http://nextcloud.org/ns',
  ocs: 'http://open-collaboration-services.org/ns'
}

@Injectable()
export class NcPropfindService {
  private readonly logger = new Logger(NcPropfindService.name)
  private readonly xml = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    format: false,
    suppressEmptyNode: false
  })

  constructor(
    private readonly webdavSpaces: WebDAVSpaces,
    private readonly fileRowEnsurer: NcFileRowEnsurer,
    private readonly shareMounts: NcShareMountResolverService,
    private readonly favorites: FavoritesManager
  ) {}

  async respond(req: FastifyDAVRequest, res: FastifyReply, mode: NcPermissionsMode): Promise<FastifyReply> {
    const space = req.space
    if (!space) {
      throw new HttpException('Space not attached to request', HttpStatus.INTERNAL_SERVER_ERROR)
    }
    const repository = mode === 'trashbin' ? SPACE_REPOSITORY.TRASH : SPACE_REPOSITORY.FILES

    const responses: unknown[] = []
    let isFirst = true
    const user = req.user as UserModel | undefined
    // Owner display name for <oc:owner-display-name>. For mobile-compat's
    // personal-space scope the file owner IS the requester, so we use the
    // requester's fullName. When the resolved owner is someone else (future
    // shared-space mode) we fall back to login inside the prop builder.
    const ownerDisplayName = user && space.root?.owner?.id === user.id ? user.fullName : ''
    // Quota figures attached to the root response only (and only in files
    // mode) so iOS renders the quota bar at the user-home view. Sync-in's
    // UserModel exposes storageUsage / storageQuota as numbers; the prop
    // builder translates `total <= 0` to the ownCloud "-3 unlimited" sentinel.
    const rootQuota = user
      ? { used: user.storageUsage ?? 0, total: user.storageQuota && user.storageQuota > 0 ? user.storageQuota : undefined }
      : undefined
    // Owner fallback: personal-space SpaceEnvs lack space.root.owner (see
    // space-env.model.ts:71 synthetic root construction). The requester IS
    // the owner of their own personal-space files, so we pass them through
    // as a fallback for <oc:owner-id> / <oc:owner-display-name>. Empty
    // owner-id was the root cause of NC Android's "no permissions to create
    // files/folders here" message after a successful login.
    const requesterFallback = user ? { login: user.login, displayName: user.fullName || user.login } : undefined
    // Favorite-id set, fetched once per request. getFavoriteIds returns ALL of
    // the user's favorite file ids (no access filter) — correct for marking a
    // file the user is already viewing. We check membership by the post-ensure
    // real DB id below. Wrapped defensively: a favorites lookup failure
    // degrades to "no stars" rather than failing the whole PROPFIND.
    let favoriteIds = new Set<number>()
    if (user) {
      try {
        favoriteIds = new Set(await this.favorites.getFavoriteIds(user))
      } catch (e) {
        this.logger.warn({ tag: this.respond.name, msg: `favorite-id lookup failed (degrading to no stars): ${(e as Error).message}` })
      }
    }
    try {
      for await (const f of this.webdavSpaces.propfind(req, repository)) {
        // The first yielded entry from `webdavSpaces.listFiles` is the
        // collection itself (with `isCurrent=true`); the rest are its
        // children. Sync-in's "virtual endpoint protection" strips DELETE
        // from `space.envPermissions` so a user can't delete their own
        // personal-space root — but that protection MUST NOT propagate to
        // child files, otherwise NC iOS hides the trash action for every
        // file. Pass envPermissions for the root, full permissions for the
        // children.
        //
        // Promote FS-only ids (negative inode placeholders) to real DB ids
        // so NC iOS can resolve subsequent fileId-keyed calls (preview,
        // favorites, comments). The ensurer covers both files and dirs
        // (see #209 — abs(inode) collisions could alias a file DB id with
        // a dir inode) and is a no-op when the id is already real or the
        // request targets the trash repository.
        f.id = await this.fileRowEnsurer.ensure(f, space, user)
        responses.push(
          buildNcPropResponse(f, space, mode, isFirst, ownerDisplayName, isFirst ? rootQuota : undefined, requesterFallback, favoriteIds.has(f.id))
        )
        isFirst = false
      }
      // After the home space's own entries, append one virtual response per
      // share-mount the user has received. Only at the NC home root and only
      // when the client asked for at least one level of children (Depth >= 1)
      // — at Depth: 0 we only describe the home root itself, which doesn't
      // include the mounts.
      if (user && mode === 'files' && req.nc?.isHomeRoot === true && req.dav?.depth !== DEPTH.RESOURCE) {
        const hrefBase = `/remote.php/dav/files/${rawurlencodeSegment(user.login)}/`
        // Wrap the mount listing in its own try so a DB outage (or any
        // share-side error) degrades to "home minus mounts" rather than
        // failing the whole PROPFIND. iOS handles a partial home listing
        // gracefully; a 500 puts the account into a generic error state.
        let mounts: Awaited<ReturnType<typeof this.shareMounts.listMounts>> = []
        try {
          mounts = await this.shareMounts.listMounts(user)
        } catch (e) {
          this.logger.warn({ tag: this.respond.name, msg: `share-mount listing failed (degrading to no mounts): ${(e as Error).message}` })
        }
        for (const mount of mounts) {
          responses.push(buildShareMountPropResponse(mount, hrefBase))
        }
      }
    } catch (e) {
      if (e instanceof HttpException) throw e
      this.logger.error({ tag: this.respond.name, msg: `propfind iteration failed: ${(e as Error).message}` })
      throw new HttpException('Propfind failed', HttpStatus.INTERNAL_SERVER_ERROR)
    }

    const body = this.xml.build({
      'd:multistatus': {
        '@_xmlns:d': XMLNS.d,
        '@_xmlns:oc': XMLNS.oc,
        '@_xmlns:nc': XMLNS.nc,
        '@_xmlns:ocs': XMLNS.ocs,
        'd:response': responses
      }
    })
    return res.type(XML_CONTENT_TYPE).status(HttpStatus.MULTI_STATUS).send(`<?xml version="1.0" encoding="utf-8"?>${body}`)
  }
}

// Re-exported so the depth constant is obvious at the call site — callers
// don't need to import from webdav/constants when they only want to check
// whether the current request was depth-0.
export const NC_PROPFIND_DEPTH = DEPTH
