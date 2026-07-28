import type { MemberModel } from '../../users/models/member.model'
import type { AvatarStackUser } from '../components/avatar-stack.component'
import { avatarHue, avatarInitials } from '../components/avatar.component'

/**
 * Maps space members (managers, in practice) onto `app-v2-avatar-stack` entries.
 * Shared by the Spaces cards and the admin Spaces table so both render the same
 * gradient/initials/photo per login *and* both inherit the member-name hover
 * tooltip (#295 / #305) from the stack component.
 *
 * `MemberModel` populates `avatarUrl` from `userAvatarUrl(login)` in its
 * constructor; surfacing it means a user renders with the same backend-generated
 * PNG everywhere — the gradient + initials fallback only kicks in when the
 * member has no login (e.g. a group).
 */
export function memberAvatars(members: MemberModel[] | undefined | null): AvatarStackUser[] {
  return (members ?? []).map((m) => ({
    id: m.login ?? m.id,
    initials: avatarInitials(m.name ?? m.login ?? ''),
    hue: avatarHue(m.login ?? m.name ?? String(m.id)),
    imageUrl: m.avatarUrl ?? null,
    // Drives the avatar-stack hover tooltip (member-name parity, #295).
    label: m.name ?? m.login ?? ''
  }))
}
