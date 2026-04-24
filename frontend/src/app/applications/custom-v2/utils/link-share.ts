import { HttpClient } from '@angular/common/http'
import type { FileSpace } from '@sync-in-server/backend/src/applications/files/interfaces/file-space.interface'
import { LINK_TYPE } from '@sync-in-server/backend/src/applications/links/constants/links'
import type { CreateOrUpdateLinkDto } from '@sync-in-server/backend/src/applications/links/dto/create-or-update-link.dto'
import type { LinkGuest } from '@sync-in-server/backend/src/applications/links/interfaces/link-guest.interface'
import { API_SHARES_LINKS, API_SHARES_LINKS_UUID, SHARES_ROUTE } from '@sync-in-server/backend/src/applications/shares/constants/routes'
import type { CreateOrUpdateShareDto } from '@sync-in-server/backend/src/applications/shares/dto/create-or-update-share.dto'
import type { ShareProps } from '@sync-in-server/backend/src/applications/shares/interfaces/share-props.interface'
import { map, Observable } from 'rxjs'
import { LINKS_PATH } from '../../links/links.constants'

export interface LinkSettingsInput {
  uuid: string
  password?: string | null
  requireAuth: boolean
  expiresAt?: Date | null
  isActive: boolean
}

export interface CreateLinkParams {
  file: Pick<FileSpace, 'id' | 'name' | 'isDir' | 'mime' | 'space'>
  // path relative to the file's space root (i.e. what the share DTO wants in `file.path`)
  relativePath: string
  // owner id of the file; null when the current user owns the file
  ownerId: number | null
  settings: LinkSettingsInput
}

export function genLinkUuid(http: HttpClient): Observable<string> {
  return http.get<{ uuid: string }>(API_SHARES_LINKS_UUID).pipe(map((r) => r.uuid))
}

export function createLinkShare(http: HttpClient, p: CreateLinkParams): Observable<ShareProps> {
  const dto: CreateOrUpdateShareDto = {
    name: p.file.name,
    enabled: true,
    file: {
      id: p.file.id,
      ownerId: p.ownerId as number,
      path: p.relativePath,
      space: p.file.space as never
    },
    members: [],
    links: [
      {
        // Backend's shares-manager treats link.id < 0 as "new"; id ≥ 0 goes through an update
        // path that 404s for unknown ids. Classic uses -1, so we match.
        id: -1,
        type: 'link' as never,
        permissions: '',
        linkSettings: toLinkDto(p.settings)
      }
    ]
  }
  return http.post<ShareProps>(SHARES_ROUTE.BASE, dto)
}

export function updateLinkOnShare(http: HttpClient, shareId: number, linkId: number, settings: LinkSettingsInput): Observable<LinkGuest> {
  // /app/shares/links/:linkId/share/:shareId
  return http.put<LinkGuest>(`${API_SHARES_LINKS}/${linkId}/${LINK_TYPE.SHARE}/${shareId}`, toLinkDto(settings))
}

export function deleteLinkShare(http: HttpClient, shareId: number): Observable<void> {
  return http.delete<void>(`${SHARES_ROUTE.BASE}/${shareId}`)
}

export function buildPublicLinkUrl(uuid: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return `${origin}/#/${LINKS_PATH.LINK}/${uuid}`
}

const PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generateLinkPassword(length = 12): string {
  const crypto = typeof window !== 'undefined' ? window.crypto : undefined
  if (crypto?.getRandomValues) {
    const bytes = new Uint32Array(length)
    crypto.getRandomValues(bytes)
    let out = ''
    for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length]
    return out
  }
  let out = ''
  for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[Math.floor(Math.random() * PASSWORD_ALPHABET.length)]
  return out
}

function toLinkDto(settings: LinkSettingsInput): CreateOrUpdateLinkDto {
  const dto: CreateOrUpdateLinkDto = {
    uuid: settings.uuid,
    isActive: settings.isActive,
    requireAuth: settings.requireAuth,
    permissions: ''
  }
  if (settings.password) dto.password = settings.password
  if (settings.expiresAt) dto.expiresAt = settings.expiresAt
  return dto
}
