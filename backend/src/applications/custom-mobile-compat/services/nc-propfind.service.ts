import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common'
import { FastifyReply } from 'fastify'
import { XMLBuilder } from 'fast-xml-parser'
import { SPACE_REPOSITORY } from '../../spaces/constants/spaces'
import { UserModel } from '../../users/models/user.model'
import { DEPTH, XML_CONTENT_TYPE } from '../../webdav/constants/webdav'
import { FastifyDAVRequest } from '../../webdav/interfaces/webdav.interface'
import { WebDAVSpaces } from '../../webdav/services/webdav-spaces.service'
import { buildNcPropResponse } from '../utils/nc-prop-builder'
import { type NcPermissionsMode } from '../utils/nc-permissions'
import { NcFileRowEnsurer } from './nc-file-row-ensurer.service'

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
    private readonly fileRowEnsurer: NcFileRowEnsurer
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
        // Promote FS-only file ids (negative inode placeholders) to real DB
        // ids so NC iOS can resolve subsequent fileId-keyed calls (preview,
        // favorites, comments). The ensurer is a no-op when the id is
        // already real, when the entry is a directory, or when the request
        // targets the trash repository.
        f.id = await this.fileRowEnsurer.ensure(f, space, user)
        responses.push(buildNcPropResponse(f, space, mode, isFirst, ownerDisplayName, isFirst ? rootQuota : undefined, requesterFallback))
        isFirst = false
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
