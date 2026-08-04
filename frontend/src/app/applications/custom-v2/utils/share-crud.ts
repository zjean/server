import { HttpClient } from '@angular/common/http'
import type { FileSpace } from '@sync-in-server/backend/src/applications/files/interfaces/file-space.interface'
import { SHARES_ROUTE } from '@sync-in-server/backend/src/applications/shares/constants/routes'
import type { CreateOrUpdateShareDto } from '@sync-in-server/backend/src/applications/shares/dto/create-or-update-share.dto'
import type { ShareProps } from '@sync-in-server/backend/src/applications/shares/interfaces/share-props.interface'
import { SPACE_OPERATION, SPACE_PERMS_SEP } from '@sync-in-server/backend/src/applications/spaces/constants/spaces'
import { MEMBER_TYPE } from '@sync-in-server/backend/src/applications/users/constants/member'
import { Observable } from 'rxjs'

export type PermissionPreset = 'viewer' | 'editor' | 'manager'

// A permission string is a `:`-SEPARATED list of SPACE_OPERATION tokens — e.g. 'a:m:d:so'.
// The separator is `SPACE_PERMS_SEP` (backend/src/applications/spaces/constants/spaces.ts:3) and
// every producer/consumer on both sides of the wire splits or joins on it: backend
// `uniquePermissions`/`differencePermissions` (common/functions.ts), `intersectPermissions`
// (common/shared.ts), `toNcPermissions` (custom-mobile-compat/utils/nc-permissions.ts:55) and the
// classic UI's `setTextIconPermissions`/`setStringPermission` (spaces/spaces.functions.ts:9,35,47).
// Concatenation is not a valid encoding: SHARE_INSIDE ('si') and SHARE_OUTSIDE ('so') are
// two characters long, so 'dsi' is ambiguous. Never build one of these by string concatenation.
//
// Which operations are legal on a SHARE is narrower than on a space: `SHARE_ALL_OPERATIONS`
// (backend/src/applications/shares/constants/shares.ts:8-11) excludes SHARE_INSIDE, and classic
// strips it from every share member (shares/models/share.model.ts:37,72 and the member search in
// shares/components/dialogs/share-dialog.component.ts:113). The re-share permission on a share is
// SHARE_OUTSIDE — it is also the only one of the two that `toNcPermissions` translates (to NC's
// 'R' letter / Share bit). Classic likewise drops ADD and DELETE when the shared node is a file
// (share.model.ts:72-75), which is what the `isDir` argument below reproduces.
//
// Presets are a v2 affordance layered on top of classic's per-operation checkboxes:
//   viewer  — read-only, no ops
//   editor  — modify, plus add on a directory
//   manager — editor + delete (directories only) + re-share
const PRESET_OPERATIONS: Record<PermissionPreset, { dir: SPACE_OPERATION[]; file: SPACE_OPERATION[] }> = {
  viewer: { dir: [], file: [] },
  editor: { dir: [SPACE_OPERATION.ADD, SPACE_OPERATION.MODIFY], file: [SPACE_OPERATION.MODIFY] },
  manager: {
    dir: [SPACE_OPERATION.ADD, SPACE_OPERATION.MODIFY, SPACE_OPERATION.DELETE, SPACE_OPERATION.SHARE_OUTSIDE],
    file: [SPACE_OPERATION.MODIFY, SPACE_OPERATION.SHARE_OUTSIDE]
  }
}

export function presetToPermissions(preset: PermissionPreset, isDir: boolean): string {
  return PRESET_OPERATIONS[preset][isDir ? 'dir' : 'file'].join(SPACE_PERMS_SEP)
}

// Splits a permission string into its operation tokens. The single place in custom-v2 that parses
// the wire format — everything else asks this for a token set rather than substring-matching the
// raw string (which would confuse 'si' with 'so' and match 'a' inside a future multi-char token).
export function permissionTokens(perms: string | null | undefined): Set<string> {
  return new Set((perms ?? '').split(SPACE_PERMS_SEP).filter(Boolean))
}

export function hasPermission(perms: string | null | undefined, op: SPACE_OPERATION): boolean {
  return permissionTokens(perms).has(op)
}

export function permissionsToPreset(perms: string | null | undefined): PermissionPreset {
  const ops = permissionTokens(perms)
  if (ops.has(SPACE_OPERATION.DELETE) || ops.has(SPACE_OPERATION.SHARE_OUTSIDE) || ops.has(SPACE_OPERATION.SHARE_INSIDE)) return 'manager'
  if (ops.has(SPACE_OPERATION.MODIFY) || ops.has(SPACE_OPERATION.ADD)) return 'editor'
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

/** A link already on the share, echoed back on update so it survives. See `links`. */
export interface ShareLinkInput {
  /** The link MEMBER's user id — `>= 0` means "already exists, leave it alone". */
  id: number
  /** The link's own id, which is what identifies it for deletion. */
  linkId: number
  permissions: string
}

export interface UpdateShareParams {
  shareId: number
  /**
   * The share's name — its CURRENT one, unless the caller means to rename it.
   *
   * Required because the placeholder that used to sit here (`'_keep'`, with a comment
   * saying the backend would ignore it) is not ignored at all: `updateShare` diffs
   * every own-property against the stored row and writes the ones that differ
   * (`shares-manager.service.ts:240`), and a changed `name` ALSO regenerates the
   * share's alias — which is the URL people were given. Editing the people on a share
   * therefore renamed it to "_keep" and broke its link.
   */
  name: string
  description?: string
  // Full member list AFTER the edit (backend replaces the set).
  members: ShareMemberInput[]
  /**
   * The share's links, echoed back — and REQUIRED, which is the whole point of the
   * field.
   *
   * `updateShare` on the server rebuilds the member set from
   * `[...dto.members, ...dto.links]` and DELETES every member of the old set that is
   * missing from the new one — links included
   * (`shares-manager.service.ts:267` → `updateMembers` → `deleteLinkMembers`, line
   * 778). `links` defaults to `[]` in the DTO, so omitting it is not "leave the links
   * alone", it is "delete every link on this share".
   *
   * That is what this call did before: editing the people on a share silently
   * revoked its public link. Required rather than optional so the next caller cannot
   * reintroduce it by leaving the field out.
   *
   * Pass the links UNCHANGED (id >= 0, no `linkSettings`) to preserve them; the
   * server pushes those straight through.
   */
  links: ShareLinkInput[]
}

export function updateShare(http: HttpClient, p: UpdateShareParams): Observable<ShareProps> {
  const dto: Partial<CreateOrUpdateShareDto> & { id: number; name: string; members: CreateOrUpdateShareDto['members'] } = {
    id: p.shareId,
    name: p.name,
    description: p.description,
    enabled: true,
    members: p.members.map((m) => ({
      id: m.id,
      type: m.type as never,
      permissions: m.permissions
    })),
    links: p.links.map((l) => ({
      id: l.id,
      linkId: l.linkId,
      type: MEMBER_TYPE.LINK as never,
      permissions: l.permissions
      // No `linkSettings`: that is what marks a link as MODIFIED. Without it the
      // server treats the row as unchanged and simply keeps it.
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
