import { Injectable, Logger } from '@nestjs/common'
import { AUTH_SCOPE } from '../../../authentication/constants/scope'
import { UserModel } from '../../users/models/user.model'
import { UsersManager } from '../../users/services/users-manager.service'

// NcAppPasswordService — keeps the per-user pile of MOBILE_NC app-passwords
// from growing without bound.
//
// Why this exists:
//   Every NC mobile sign-in mints a fresh app-password row. NC clients only
//   call DELETE /ocs/v2.php/core/apppassword on explicit logout — uninstalls,
//   account re-adds, and mid-flow OAuth retries leave the row behind. Each
//   new row makes auth slower, because NcBasicAuthGuard.canActivate falls
//   through to UsersManager.validateAppPassword on cache miss, which
//   bcrypt-loops every row in user.secrets.appPasswords until it hits a
//   match. With dozens of stale rows, the first post-login OCS calls (which
//   all miss the per-credential cache) stack their bcrypt work and stall
//   long enough that NC iOS surfaces a generic "Fout" alert.
//
// Strategy: before minting, drop the oldest MOBILE_NC rows down to
// (MAX_MOBILE_PASSWORDS - 1), so the new mint puts the total at exactly
// MAX_MOBILE_PASSWORDS. Other scopes are untouched.
@Injectable()
export class NcAppPasswordService {
  // Maximum simultaneous MOBILE_NC app-passwords retained per user. Five
  // covers a realistic device count (iPhone, iPad, spouse's iPhone, dev
  // device, spare) without letting the row count run away.
  static readonly MAX_MOBILE_PASSWORDS = 5

  private readonly logger = new Logger(NcAppPasswordService.name)

  constructor(private readonly usersManager: UsersManager) {}

  // Trim the user's MOBILE_NC rows so a freshly-minted one stays under the
  // cap. Idempotent. Tolerates concurrent deletion races (they only matter
  // for accounting; correctness is preserved).
  async pruneMobileAppPasswords(user: UserModel, keep = NcAppPasswordService.MAX_MOBILE_PASSWORDS): Promise<number> {
    const rows = await this.usersManager.listAppPasswords(user)
    const mobile = rows
      .filter((r) => r.app === AUTH_SCOPE.MOBILE_NC)
      // Newest first — slice keeps indexes [0, limit) and drops the rest.
      .sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt))
    const limit = Math.max(0, keep - 1)
    const toDelete = mobile.slice(limit)
    let removed = 0
    for (const row of toDelete) {
      try {
        await this.usersManager.deleteAppPassword(user, row.name)
        removed++
      } catch (e) {
        // Concurrent delete or schema race — the row is gone or is going
        // away regardless. Log at debug; the prune is best-effort.
        this.logger.debug({ tag: this.pruneMobileAppPasswords.name, msg: `skip row ${row.name}: ${(e as Error).message}` })
      }
    }
    if (removed > 0) {
      this.logger.log({ tag: this.pruneMobileAppPasswords.name, msg: `pruned ${removed} stale MOBILE_NC rows for ${user.login}` })
    }
    return removed
  }
}

function toMs(d: Date | string | undefined): number {
  if (!d) return 0
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime()
  return Number.isFinite(t) ? t : 0
}
