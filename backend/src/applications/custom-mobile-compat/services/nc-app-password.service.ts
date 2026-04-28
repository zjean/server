import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common'
import { randomBytes } from 'node:crypto'
import { AUTH_SCOPE } from '../../../authentication/constants/scope'
import { hashPassword } from '../../../common/functions'
import { createLightSlug } from '../../../common/shared'
import { sanitizeName } from '../../files/utils/files'
import { UserAppPassword } from '../../users/interfaces/user-secrets.interface'
import { UserModel } from '../../users/models/user.model'
import { UsersManager } from '../../users/services/users-manager.service'
import { UsersQueries } from '../../users/services/users-queries.service'

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

  constructor(
    private readonly usersManager: UsersManager,
    private readonly usersQueries: UsersQueries
  ) {}

  // Mint a MOBILE_NC app-password whose cleartext is **URL-safe** so the
  // `nc://login/server:...&password:...` deep-link round-trip survives any
  // percent-decoding NC iOS / Android does on the receiving side.
  //
  // Why we don't just delegate to UsersManager.generateAppPassword:
  //   The shared helper draws cleartext from `genPassword`'s mixed-symbol
  //   alphabet (`!@#$%^&*()` included). Per-char that's safe; in aggregate
  //   ~50% of 24-char outputs contain `&` or `#`. After encodeURIComponent
  //   those become `%26` / `%23` in the URL, but if the receiving NC client
  //   reads the path through an API that auto-decodes percent-encoding
  //   (e.g. Swift's `URL.path`), the literal `&` reappears mid-password and
  //   the deep-link parser splits the password where it shouldn't. The
  //   captured cleartext is then truncated, and the very first authenticated
  //   request after sign-in is rejected with 401 — surfacing as the user-
  //   visible "Fout: Unauthorized" alert.
  //
  // Fix: limit the cleartext to base64url (`A–Z a–z 0–9 - _`), 144 bits of
  // entropy. Identical hash schedule as the upstream helper (bcrypt 10
  // rounds via `hashPassword`) — only the alphabet changes.
  async mintMobileAppPassword(user: UserModel, name: string): Promise<{ name: string; password: string }> {
    const slugName = createLightSlug(sanitizeName(name))
    if (!slugName) throw new HttpException('Invalid app-password name', HttpStatus.BAD_REQUEST)

    const secrets = await this.usersQueries.getUserSecrets(user.id)
    if (Array.isArray(secrets.appPasswords) && secrets.appPasswords.find((p) => p.name === slugName)) {
      throw new HttpException('Name already used', HttpStatus.BAD_REQUEST)
    }
    secrets.appPasswords = Array.isArray(secrets.appPasswords) ? secrets.appPasswords : []

    // 18 bytes → 24 base64url chars → 144 bits entropy. Comfortably above
    // the upstream 24-char × 73-symbol-alphabet ≈ 148 bits.
    const clearPassword = randomBytes(18).toString('base64url')

    const newRow: UserAppPassword = {
      name: slugName,
      app: AUTH_SCOPE.MOBILE_NC,
      // Match the upstream row shape; nullable fields remain null until the
      // password is exercised (currentAccess is set on first successful auth).
      expiration: null as unknown as Date,
      password: await hashPassword(clearPassword),
      createdAt: new Date(),
      currentIp: null as unknown as string,
      currentAccess: null as unknown as Date,
      lastIp: null as unknown as string,
      lastAccess: null as unknown as Date
    }
    secrets.appPasswords.unshift(newRow)
    if (!(await this.usersQueries.updateUserOrGuest(user.id, { secrets }))) {
      throw new HttpException('Unable to persist app password', HttpStatus.INTERNAL_SERVER_ERROR)
    }
    return { name: slugName, password: clearPassword }
  }

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
