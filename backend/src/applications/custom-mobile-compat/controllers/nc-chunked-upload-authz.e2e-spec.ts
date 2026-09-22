import { NestFastifyApplication } from '@nestjs/platform-fastify'
import fs from 'node:fs/promises'
import path from 'node:path'
import { appBootstrap } from '../../../app.bootstrap'
import { FilesQuotaManager } from '../../files/services/files-quota-manager.service'
import { USER_PERMISSION, USER_PERMS_SEP, USER_ROLE } from '../../users/constants/user'
import { UserModel } from '../../users/models/user.model'
import { AdminUsersManager } from '../../users/services/admin-users-manager.service'
import { generateUserTest } from '../../users/utils/test'
import { NcAppPasswordService } from '../services/nc-app-password.service'

// Authorization on the NC CHUNKED-UPLOAD assembly — the one NC write path that
// does not go through NcDavController.
//
// WHY THIS EXISTS, AND WHY IT IS AN e2e RATHER THAN A UNIT SPEC. #515 put
// Sync-in's two authorization halves — `canAccessToSpaceUrl` (the user-level
// repository gate) and `SpaceGuard.checkPermissions` (the space/root overlay,
// the trash rule and the quota rule) — on NcDavController.attachSpace, which
// covers every NC DAV verb. `NcUploadsController.assembleAndMove` is a second
// entry point into exactly the same write, and it had neither: it checked only
// `haveSpaceEnvPermissions(space, ADD|MODIFY)`. So the byte-identical write was
// refused as
//
//     PUT /remote.php/dav/files/{user}/x.bin                      → 403
//
// and accepted as
//
//     MKCOL /remote.php/dav/uploads/{user}/u1
//     PUT   /remote.php/dav/uploads/{user}/u1/0
//     MOVE  /remote.php/dav/uploads/{user}/u1/.file
//       Destination: /remote.php/dav/files/{user}/x.bin           → 201
//
// A spec that constructs the guard and asks it about a fabricated principal
// proves the DECISION; it cannot prove the decision is in the REQUEST PATH, and
// the request path is the entire defect. These cases therefore drive the real
// three-verb sequence over HTTP.
//
// And each refusal is asserted twice: the status code, AND that nothing landed
// at the destination. A status code alone cannot tell "refused" from "refused
// after writing" — the assembly's last act is `moveFiles(tmp, realPath, true)`,
// so a check that ran too late would answer 4xx over a file it had already
// replaced.
describe('NC chunked upload authorization (e2e)', () => {
  let app: NestFastifyApplication
  let admin: AdminUsersManager
  const created: UserModel[] = []

  // One account + one MOBILE_NC app password. The guard accepts only
  // app-passwords scoped to MOBILE_NC (never the login password), and it caches
  // the resolved UserModel keyed on the credential pair — so every account here
  // gets its own credential and its own cache entry, and nothing one case does
  // to a user can leak into another.
  const makeUser = async (permissions: USER_PERMISSION[], extra: Record<string, unknown> = {}) => {
    // `permissions` is the column; `applications` is derived from it and is not
    // one. A user built straight from generateUserTest() lands with no
    // permissions and every request 403s for the wrong reason.
    const user = await admin.createUserOrGuest(
      { ...generateUserTest(false), permissions: permissions.join(USER_PERMS_SEP), ...extra } as never,
      USER_ROLE.USER
    )
    created.push(user)
    const minted = await app.get(NcAppPasswordService).mintMobileAppPassword(user, `authz-e2e-${Date.now()}`)
    return { user, auth: `Basic ${Buffer.from(`${user.login}:${minted.password}`).toString('base64')}` }
  }

  const ALL_PERMISSIONS = Object.values(USER_PERMISSION)

  beforeAll(async () => {
    app = await appBootstrap()
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    admin = app.get(AdminUsersManager)
  })

  afterAll(async () => {
    for (const u of created) {
      if (u?.id) {
        await admin.deleteUserOrGuest(u.id, u.login, { deleteSpace: true, isGuest: false } as never).catch(() => undefined)
      }
    }
    await app?.close()
  })

  const nc = (auth: string, method: string, url: string, opts: { payload?: string; headers?: Record<string, string> } = {}) =>
    app.inject({
      method,
      url,
      headers: { authorization: auth, ...(opts.headers ?? {}) },
      ...(opts.payload === undefined ? {} : { payload: opts.payload })
    } as never)

  // The full protocol, as a stock NC client drives it. Returns the MOVE's
  // response — the assembly is the moment authorization has to have happened.
  const chunkedUpload = async (auth: string, login: string, rel: string, payload: string) => {
    const uploadId = `authz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const uploadRoot = `/remote.php/dav/uploads/${login}/${uploadId}`
    const mkcol = await nc(auth, 'MKCOL', uploadRoot)
    const put = await nc(auth, 'PUT', `${uploadRoot}/00000001`, { payload })
    const move = await nc(auth, 'MOVE', `${uploadRoot}/.file`, {
      headers: { destination: `/remote.php/dav/files/${login}/${rel}`, 'oc-total-length': String(Buffer.byteLength(payload)) }
    })
    return { mkcol, put, move }
  }

  const destinationOf = (login: string, rel: string) => path.join(UserModel.getFilesPath(login), rel)

  const absent = async (p: string) => await expect(fs.stat(p)).rejects.toMatchObject({ code: 'ENOENT' })

  /* --------------------------------------------------- the positive control */

  // Without this, every assertion below could pass because the harness is
  // broken rather than because the gate works.
  it('an account that may write does complete the chunked upload', async () => {
    const { user, auth } = await makeUser(ALL_PERMISSIONS)
    const rel = 'authz-control.bin'
    const body = 'Z'.repeat(2048)

    const { mkcol, put, move } = await chunkedUpload(auth, user.login, rel, body)
    expect(mkcol.statusCode).toBe(201)
    expect([200, 201, 204]).toContain(put.statusCode)
    expect([201, 204]).toContain(move.statusCode)

    expect(await fs.readFile(destinationOf(user.login, rel), 'utf8')).toBe(body)
  })

  /* ------------------ (a) the repository gate — the regression this PR made */

  // The gate is `canAccessToSpaceUrl`, and it answers per repository:
  // files/personal → PERSONAL_SPACE, files/<space> → SPACES, shares/<alias> →
  // SHARES. This case revokes PERSONAL_SPACE and writes into the account's own
  // home, which is the arm reachable without provisioning a donor account, a
  // share and a membership row. It is the SAME call at the SAME point for all
  // three arms — NcDavController's own coverage pins the others — and it is the
  // presence of the call in this controller's request path that was missing.
  //
  // The share arm is the one this PR newly exposed: routing the assembly
  // through `buildNcUrlSegments` (the #516 fix) made `shares/<alias>/…`
  // resolvable from here for the first time.
  it('refuses the assembly for an account without PERSONAL_SPACE, and writes nothing', async () => {
    const { user, auth } = await makeUser(ALL_PERMISSIONS.filter((p) => p !== USER_PERMISSION.PERSONAL_SPACE))
    const rel = 'authz-no-personal.bin'
    const dest = destinationOf(user.login, rel)

    // Parity baseline: the same write, one request, through NcDavController.
    const direct = await nc(auth, 'PUT', `/remote.php/dav/files/${user.login}/${rel}`, { payload: 'direct' })
    expect(direct.statusCode).toBe(403)
    await absent(dest)

    const { move } = await chunkedUpload(auth, user.login, rel, 'chunked'.repeat(64))
    expect(move.statusCode).toBe(403)
    // The assembly's final act replaces the destination, so "nothing landed" is
    // a separate claim from "the answer was 403".
    await absent(dest)
  })

  /* ---------------------------------------------- (c) the quota rule, for free */

  // Quota is precisely the rule large uploads exist to test, and it was the one
  // the chunked path did not apply: `haveSpaceEnvPermissions` answers only the
  // operation question. Reusing `SpaceGuard.checkPermissions` carries the
  // 507 across without restating it.
  //
  // The personal space's quota is the USER's, computed by
  // FilesQuotaManager.updatePersonalSpacesQuota from the real on-disk size of
  // the home and cached. So: a 1-byte quota, a file on disk that exceeds it,
  // then one recompute to publish that pair into the cache the request will
  // read.
  it('refuses the assembly with 507 when the destination space is over quota, and writes nothing', async () => {
    const { user, auth } = await makeUser(ALL_PERMISSIONS, { storageQuota: 1 })
    const filesPath = UserModel.getFilesPath(user.login)
    await fs.mkdir(filesPath, { recursive: true })
    await fs.writeFile(path.join(filesPath, 'authz-quota-ballast.bin'), 'B'.repeat(8192))
    const quota = await app.get(FilesQuotaManager).updatePersonalSpacesQuota(user.id)
    // Guard the premise: if usage did not exceed the quota, a 507 below would
    // be coming from somewhere else and a 201 would be a false negative.
    expect(quota.storageUsage).toBeGreaterThanOrEqual(quota.storageQuota)

    const rel = 'authz-over-quota.bin'
    const dest = destinationOf(user.login, rel)

    const direct = await nc(auth, 'PUT', `/remote.php/dav/files/${user.login}/${rel}`, { payload: 'direct' })
    expect(direct.statusCode).toBe(507)
    await absent(dest)

    const { move } = await chunkedUpload(auth, user.login, rel, 'C'.repeat(4096))
    expect(move.statusCode).toBe(507)
    await absent(dest)
  })

  /* ------------------------------------------ (b) the disabled-space rule */

  // NOT COVERED HERE, DELIBERATELY, and the reason is worth recording so nobody
  // re-derives it: `space.enabled` cannot currently be false for anything the
  // NC surface can address through `assembleAndMove`. A personal space is the
  // static SPACE_PERSONAL SpaceEnv, which is always enabled, and the only
  // redirect away from it — NcPathResolverService's `settings.mobileHome` —
  // reads a `settings` key that the `users` table does not have a column for,
  // so it is inert today. The check is still in the code because it is parity
  // with attachSpace and because the moment either of those facts changes
  // (a real mobileHome setting, or a share mount resolving into a disabled
  // space) its absence becomes a hole, exactly as the repository gate's absence
  // did when the #516 routing change made shares reachable from here.
})
