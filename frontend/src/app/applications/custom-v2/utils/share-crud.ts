import { HttpClient } from '@angular/common/http'
import type { FileSpace } from '@sync-in-server/backend/src/applications/files/interfaces/file-space.interface'
import { SHARES_ROUTE } from '@sync-in-server/backend/src/applications/shares/constants/routes'
import type { CreateOrUpdateShareDto } from '@sync-in-server/backend/src/applications/shares/dto/create-or-update-share.dto'
import type { ShareProps } from '@sync-in-server/backend/src/applications/shares/interfaces/share-props.interface'
import { MEMBER_TYPE } from '@sync-in-server/backend/src/applications/users/constants/member'
import { Observable } from 'rxjs'

export type PermissionPreset = 'viewer' | 'editor' | 'manager'

// Maps preset → concatenated permission string used by the backend (SPACE_OPERATION letters).
//   viewer  — read-only, no ops
//   editor  — add + modify; delete requires a dir, add too — so file shares fall back to 'm'
//   manager — add + modify + delete + share-inside
export function presetToPermissions(preset: PermissionPreset, isDir: boolean): string {
  switch (preset) {
    case 'viewer':
      return ''
    case 'editor':
      return isDir ? 'am' : 'm'
    case 'manager':
      return isDir ? 'amdsi' : 'msi'
  }
}

export function permissionsToPreset(perms: string | null | undefined): PermissionPreset {
  const p = perms ?? ''
  if (p.includes('d') || p.includes('si')) return 'manager'
  if (p.includes('m') || p.includes('a')) return 'editor'
  return 'viewer'
}

export interface ShareMemberInput {
  id: number
  type: MEMBER_TYPE
  permissions: string
}

export interface CreateShareParams {
  file: Pick<FileSpace, 'id' | 'name' | 'isDir' | 'mime' | 'space'>
  relativePath: string
  // null when current user owns the file; number otherwise
  ownerId: number | null
  description?: string
  members: ShareMemberInput[]
}

export function createShare(http: HttpClient, p: CreateShareParams): Observable<ShareProps> {
  const dto: CreateOrUpdateShareDto = {
    name: p.file.name,
    enabled: true,
    description: p.description,
    file: {
      id: p.file.id,
      ownerId: p.ownerId as number,
      path: p.relativePath,
      space: p.file.space as never
    },
    members: p.members.map((m) => ({
      id: m.id,
      type: m.type as never,
      permissions: m.permissions
    })),
    links: []
  }
  return http.post<ShareProps>(SHARES_ROUTE.BASE, dto)
}

export interface UpdateShareParams {
  shareId: number
  description?: string
  // Full member list AFTER the edit (backend replaces the set).
  members: ShareMemberInput[]
}

export function updateShare(http: HttpClient, p: UpdateShareParams): Observable<ShareProps> {
  const dto: Partial<CreateOrUpdateShareDto> & { id: number; name: string; members: CreateOrUpdateShareDto['members'] } = {
    id: p.shareId,
    name: '_keep', // backend requires non-empty; will be overwritten by its own state for existing shares
    description: p.description,
    enabled: true,
    members: p.members.map((m) => ({
      id: m.id,
      type: m.type as never,
      permissions: m.permissions
    }))
  }
  return http.put<ShareProps>(`${SHARES_ROUTE.BASE}/${p.shareId}`, dto)
}

export function deleteShare(http: HttpClient, shareId: number): Observable<void> {
  return http.delete<void>(`${SHARES_ROUTE.BASE}/${shareId}`)
}

export function getShare(http: HttpClient, shareId: number): Observable<ShareProps> {
  return http.get<ShareProps>(`${SHARES_ROUTE.BASE}/${shareId}`)
}
