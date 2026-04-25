import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common'
import { FastifyReply } from 'fastify'
import { XMLBuilder } from 'fast-xml-parser'
import { SPACE_REPOSITORY } from '../../spaces/constants/spaces'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { DEPTH, XML_CONTENT_TYPE } from '../../webdav/constants/webdav'
import { FastifyDAVRequest } from '../../webdav/interfaces/webdav.interface'
import { WebDAVFile } from '../../webdav/models/webdav-file.model'
import { WebDAVSpaces } from '../../webdav/services/webdav-spaces.service'
import { buildOcId, ncFileId } from '../utils/nc-oc-id'
import { toNcPermissions, type NcPermissionsMode } from '../utils/nc-permissions'
import { ncHasPreview } from '../utils/nc-preview-predicate'

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

const HTTP_OK_PROPSTAT_STATUS = 'HTTP/1.1 200 OK'

@Injectable()
export class NcPropfindService {
  private readonly logger = new Logger(NcPropfindService.name)
  private readonly xml = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    format: false,
    suppressEmptyNode: false
  })

  constructor(private readonly webdavSpaces: WebDAVSpaces) {}

  async respond(req: FastifyDAVRequest, res: FastifyReply, mode: NcPermissionsMode): Promise<FastifyReply> {
    const space = req.space
    if (!space) {
      throw new HttpException('Space not attached to request', HttpStatus.INTERNAL_SERVER_ERROR)
    }
    const repository = mode === 'trashbin' ? SPACE_REPOSITORY.TRASH : SPACE_REPOSITORY.FILES

    const responses: unknown[] = []
    try {
      for await (const f of this.webdavSpaces.propfind(req, repository)) {
        responses.push(this.buildResponse(f, space, mode))
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

  private buildResponse(f: WebDAVFile, space: SpaceEnv, mode: NcPermissionsMode): Record<string, unknown> {
    const href = f.href
    const { letters, shareMask } = toNcPermissions(space.envPermissions ?? space.permissions, f.isDir, mode)

    // Owner: prefer the space root owner (share/external root); fall back to
    // the space owner field (which is populated for personal space from the
    // authenticated user earlier in the request pipeline).
    const owner = space.root?.owner ?? { id: 0, login: '' }
    const ownerDisplay = owner.login || ''

    // d:resourcetype — <d:collection/> for dirs, empty for files
    const resourcetype = f.isDir ? { 'd:collection': '' } : ''

    // File size: rendered on both <d:getcontentlength> (files only) and
    // <oc:size> (emitted for both files and dirs; dirs report 0 since
    // Sync-in doesn't maintain a recursive size aggregate).
    const contentLength = f.isDir ? undefined : String(f.size)
    const ocSize = String(f.isDir ? 0 : f.size)

    // Stable positive id even when f.id is the negative-inode placeholder
    // Sync-in stamps onto filesystem-only files. NC iOS rejects 0/negative
    // values as cache keys, so we normalize via ncFileId().
    const positiveId = ncFileId(f.id)
    const props: Record<string, unknown> = {
      'd:displayname': f.displayname,
      'd:getlastmodified': f.getlastmodified,
      'd:getetag': f.getetag !== undefined ? f.getetag : `"${String(positiveId)}-${String(f.mtime)}"`,
      'd:resourcetype': resourcetype,
      'oc:id': buildOcId(f.id),
      'oc:fileid': String(positiveId),
      'oc:permissions': letters,
      'ocs:share-permissions': shareMask,
      'oc:size': ocSize,
      'oc:favorite': '0',
      'oc:owner-id': String(owner.login ?? ''),
      'oc:owner-display-name': ownerDisplay,
      'nc:has-preview': ncHasPreview(f.mime) ? 'true' : 'false',
      'nc:is-encrypted': '0',
      'nc:mount-type': ''
    }

    if (!f.isDir) {
      props['d:getcontenttype'] = f.getcontenttype
      if (contentLength !== undefined) props['d:getcontentlength'] = contentLength
    }

    // Trashbin extras — NC mobile clients render "deleted X ago" + the
    // original path using these three nc:* props. Sync-in doesn't persist a
    // separate trashed-at timestamp, so we use mtime (the last-modified time
    // at the moment of deletion is close enough for UX).
    if (mode === 'trashbin') {
      const baseName = stripTrashSuffix(f.name)
      props['nc:trashbin-filename'] = baseName
      props['nc:trashbin-original-location'] = originalLocationFor(f, space)
      props['nc:trashbin-deletion-time'] = String(Math.floor((f.mtime ?? Date.now()) / 1000))
    }

    return {
      'd:href': href,
      'd:propstat': {
        'd:prop': props,
        'd:status': HTTP_OK_PROPSTAT_STATUS
      }
    }
  }
}

// Deleted-file-in-trash names in some DAV servers carry a ".d<unix-ts>" suffix
// to disambiguate collisions. Sync-in doesn't add one today, so this is a
// no-op on current names — but keeping the trim is cheap and future-proof.
function stripTrashSuffix(name: string): string {
  const match = name.match(/^(.*)\.d\d+$/)
  return match ? match[1] : name
}

function originalLocationFor(f: WebDAVFile, space: SpaceEnv): string {
  // Prefer a share-origin external path when the file came in via a share;
  // otherwise fall back to the file's name (the NC client still renders
  // something sensible in that case).
  const fromOrigin = (f as WebDAVFile & { origin?: { spaceRootExternalPath?: string } }).origin?.spaceRootExternalPath
  if (typeof fromOrigin === 'string' && fromOrigin.length > 0) return fromOrigin
  // Fall back to the space alias plus filename when no richer hint exists.
  const alias = space.alias ?? ''
  return alias ? `${alias}/${f.name}` : f.name
}

// Re-exported so the depth constant is obvious at the call site — callers
// don't need to import from webdav/constants when they only want to check
// whether the current request was depth-0.
export const NC_PROPFIND_DEPTH = DEPTH
