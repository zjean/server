// The /v2/groups permission matrix, ported verbatim from classic's
// `UserGroupsComponent.onSelect()` (users/components/user-groups.component.ts:258-278).
//
// It lives in its own module — rather than inline in the component — for two
// reasons. It is the one piece of this screen that is pure logic and therefore
// cheaply testable under the repo's no-TestBed vitest harness (see
// group-actions.spec.ts), and keeping it verbatim next to a citation of the
// classic line range makes an upstream drift greppable.
//
// The asymmetry that is easy to get wrong: only PERSONAL groups can be created,
// edited, removed or left. A regular, admin-provisioned group is
// membership-only from this screen — a manager of one may add and remove its
// users, but may not rename it, delete it, or leave it.

import { GROUP_TYPE } from '@sync-in-server/backend/src/applications/users/constants/group'
import { USER_GROUP_ROLE } from '@sync-in-server/backend/src/applications/users/constants/user'

/** The subset of `GroupBrowseModel['parentGroup']` the matrix reads. */
export interface CurrentGroupRef {
  id: number
  name: string
  type: GROUP_TYPE
  role?: USER_GROUP_ROLE
}

/** The subset of `MemberModel` the matrix reads. */
export interface SelectedMemberRef {
  isUser: boolean
  isGroup: boolean
  isGroupManager: boolean
  isPersonalGroup: boolean
}

export interface GroupAllowedActions {
  addGroup: boolean
  addUsers: boolean
  removeUser: boolean
  removeGroup: boolean
  editUser: boolean
  editGroup: boolean
  leaveGroup: boolean
}

/**
 * Whether the signed-in user manages the group currently being browsed.
 *
 * Classic holds this as separate component state (`isCurrentGroupManager`,
 * assigned at :231) but it is purely derived from the browse response's
 * `parentGroup.role`, so it is derived here instead — one source of truth.
 */
export function isCurrentGroupManager(currentGroup: CurrentGroupRef | null | undefined): boolean {
  return currentGroup?.role === USER_GROUP_ROLE.MANAGER
}

/**
 * The seven gates, in classic's order. `selected` is null at the toolbar level
 * (nothing picked), which is classic's `!this.selected` branch: only `addGroup`
 * and `addUsers` can be true there.
 */
export function groupAllowedActions(
  currentGroup: CurrentGroupRef | null | undefined,
  selected: SelectedMemberRef | null | undefined,
  canCreatePersonalGroup: boolean
): GroupAllowedActions {
  const inGroup = !!currentGroup
  const manager = isCurrentGroupManager(currentGroup)
  const s = selected ?? null
  return {
    addGroup: !inGroup && canCreatePersonalGroup,
    addUsers: inGroup && manager,
    removeUser: inGroup && !!s && s.isUser && manager,
    removeGroup: !inGroup && !!s && s.isGroup && s.isGroupManager && s.isPersonalGroup,
    editUser: inGroup && !!s && s.isUser && manager && currentGroup!.type === GROUP_TYPE.PERSONAL,
    editGroup: !inGroup && !!s && s.isGroup && s.isGroupManager && s.isPersonalGroup,
    leaveGroup: !inGroup && !!s && s.isGroup && s.isPersonalGroup
  }
}
