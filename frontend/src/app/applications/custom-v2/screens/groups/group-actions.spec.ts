import { GROUP_TYPE } from '@sync-in-server/backend/src/applications/users/constants/group'
import { USER_GROUP_ROLE } from '@sync-in-server/backend/src/applications/users/constants/user'
import { describe, expect, it } from 'vitest'
import { type CurrentGroupRef, groupAllowedActions, isCurrentGroupManager, type SelectedMemberRef } from './group-actions'

// USER_GROUP_ROLE.MEMBER is 0 and MANAGER is 1 — numeric enum members, so a
// truthiness test on `role` would read MEMBER as "no role". Every case here
// passes the role explicitly for that reason.

function group(over: Partial<CurrentGroupRef> = {}): CurrentGroupRef {
  return { id: 7, name: 'Team', type: GROUP_TYPE.USER, role: USER_GROUP_ROLE.MEMBER, ...over }
}

function personalGroupRow(over: Partial<SelectedMemberRef> = {}): SelectedMemberRef {
  return { isUser: false, isGroup: true, isGroupManager: true, isPersonalGroup: true, ...over }
}

function regularGroupRow(over: Partial<SelectedMemberRef> = {}): SelectedMemberRef {
  return { isUser: false, isGroup: true, isGroupManager: true, isPersonalGroup: false, ...over }
}

function userRow(over: Partial<SelectedMemberRef> = {}): SelectedMemberRef {
  return { isUser: true, isGroup: false, isGroupManager: false, isPersonalGroup: false, ...over }
}

const NONE = { addGroup: false, addUsers: false, removeUser: false, removeGroup: false, editUser: false, editGroup: false, leaveGroup: false }

describe('isCurrentGroupManager', () => {
  it('is false with no group being browsed — the root has no role to hold', () => {
    expect(isCurrentGroupManager(null)).toBe(false)
    expect(isCurrentGroupManager(undefined)).toBe(false)
  })

  it('distinguishes MANAGER from MEMBER, and from an absent role', () => {
    expect(isCurrentGroupManager(group({ role: USER_GROUP_ROLE.MANAGER }))).toBe(true)
    expect(isCurrentGroupManager(group({ role: USER_GROUP_ROLE.MEMBER }))).toBe(false)
    expect(isCurrentGroupManager(group({ role: undefined }))).toBe(false)
  })
})

describe('groupAllowedActions — root level (no group being browsed)', () => {
  it('offers nothing at all without the personal-groups permission and nothing selected', () => {
    expect(groupAllowedActions(null, null, false)).toEqual(NONE)
  })

  it('gates group creation on the personal-groups permission, not on a selection', () => {
    expect(groupAllowedActions(null, null, true)).toEqual({ ...NONE, addGroup: true })
    expect(groupAllowedActions(null, personalGroupRow(), true).addGroup).toBe(true)
  })

  it('never offers addUsers at the root — there is no group to add them to', () => {
    expect(groupAllowedActions(null, personalGroupRow(), true).addUsers).toBe(false)
  })

  it('allows edit + remove + leave on a personal group I manage', () => {
    expect(groupAllowedActions(null, personalGroupRow(), true)).toEqual({
      ...NONE,
      addGroup: true,
      removeGroup: true,
      editGroup: true,
      leaveGroup: true
    })
  })

  // The asymmetry the issue calls out: an admin-provisioned group is
  // membership-only from this screen even when I manage it.
  it('refuses edit, remove AND leave on a regular group, even one I manage', () => {
    const a = groupAllowedActions(null, regularGroupRow({ isGroupManager: true }), true)
    expect(a.editGroup).toBe(false)
    expect(a.removeGroup).toBe(false)
    expect(a.leaveGroup).toBe(false)
  })

  it('lets a non-manager member LEAVE a personal group but not edit or remove it', () => {
    const a = groupAllowedActions(null, personalGroupRow({ isGroupManager: false }), true)
    expect(a.leaveGroup).toBe(true)
    expect(a.editGroup).toBe(false)
    expect(a.removeGroup).toBe(false)
  })

  it('offers no per-row action for a user row at the root — the root only ever lists groups', () => {
    expect(groupAllowedActions(null, userRow(), true)).toEqual({ ...NONE, addGroup: true })
  })

  it('does not let the personal-groups permission unlock edit/remove/leave on its own', () => {
    // canCreatePersonalGroup gates exactly one gate.
    const withPerm = groupAllowedActions(null, personalGroupRow(), true)
    const withoutPerm = groupAllowedActions(null, personalGroupRow(), false)
    expect({ ...withPerm, addGroup: false }).toEqual({ ...withoutPerm, addGroup: false })
    expect(withoutPerm.addGroup).toBe(false)
  })
})

describe('groupAllowedActions — inside a group', () => {
  it('offers nothing but membership reads to a plain member', () => {
    const g = group({ role: USER_GROUP_ROLE.MEMBER })
    expect(groupAllowedActions(g, null, true)).toEqual(NONE)
    expect(groupAllowedActions(g, userRow(), true)).toEqual(NONE)
  })

  it('lets a manager add and remove users in a REGULAR group, but not edit their role', () => {
    const g = group({ type: GROUP_TYPE.USER, role: USER_GROUP_ROLE.MANAGER })
    const a = groupAllowedActions(g, userRow(), true)
    expect(a.addUsers).toBe(true)
    expect(a.removeUser).toBe(true)
    // editUser additionally requires the group be personal.
    expect(a.editUser).toBe(false)
  })

  it('lets a manager edit a user role only in a PERSONAL group', () => {
    const g = group({ type: GROUP_TYPE.PERSONAL, role: USER_GROUP_ROLE.MANAGER })
    expect(groupAllowedActions(g, userRow(), true).editUser).toBe(true)
  })

  it('never offers addGroup inside a group, whatever the permission says', () => {
    const g = group({ type: GROUP_TYPE.PERSONAL, role: USER_GROUP_ROLE.MANAGER })
    expect(groupAllowedActions(g, userRow(), true).addGroup).toBe(false)
    expect(groupAllowedActions(g, null, true).addGroup).toBe(false)
  })

  it('never offers removeGroup / editGroup / leaveGroup inside a group', () => {
    const g = group({ type: GROUP_TYPE.PERSONAL, role: USER_GROUP_ROLE.MANAGER })
    // A nested group row cannot occur in practice (the browse of a group returns
    // users), but the gates must still refuse it rather than acting on the wrong id.
    const a = groupAllowedActions(g, personalGroupRow(), true)
    expect(a.removeGroup).toBe(false)
    expect(a.editGroup).toBe(false)
    expect(a.leaveGroup).toBe(false)
  })

  it('requires a user row for removeUser / editUser — a group row must not arm them', () => {
    const g = group({ type: GROUP_TYPE.PERSONAL, role: USER_GROUP_ROLE.MANAGER })
    const a = groupAllowedActions(g, personalGroupRow(), true)
    expect(a.removeUser).toBe(false)
    expect(a.editUser).toBe(false)
  })

  it('offers addUsers with nothing selected — it is a toolbar action, not a row action', () => {
    const g = group({ role: USER_GROUP_ROLE.MANAGER })
    expect(groupAllowedActions(g, null, false)).toEqual({ ...NONE, addUsers: true })
  })
})
