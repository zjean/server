// reflect-metadata FIRST: this spec imports space models before the fixture, and
// those transitively evaluate class-validator/class-transformer decorators on
// files.config.ts. Every other e2e spec happens to import @nestjs/platform-fastify
// (which loads the shim) before anything decorated; relying on that accident is
// what produces 'Reflect.getMetadata is not a function' at collection time.
import 'reflect-metadata'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { SpaceModel } from '../spaces/models/space.model'
import { SpacesManager } from '../spaces/services/spaces-manager.service'
import { MEMBER_TYPE } from '../users/constants/member'
import { USER_ROLE } from '../users/constants/user'
import { UserModel } from '../users/models/user.model'
import { AdminUsersQueries } from '../users/services/admin-users-queries.service'
import { UsersQueries } from '../users/services/users-queries.service'
import { SPACE_OPERATION, SPACE_PERMS_SEP, SPACE_ROLE } from '../spaces/constants/spaces'
import { setupVersionsE2E, type VersionsActor, type VersionsE2EContext } from './utils/versions-e2e.fixture'
import type { VersionsApi } from './utils/versions-e2e.fixture'

// Phase E, case E2E-7: the permission matrix.
//
// This is the only case that asserts WHO may do WHAT, and it is the one that
// needs more than one actor — which is why it lives on its own. The rule the ADR
// sets is asymmetric on purpose:
//
//   GET carries NO required permission (SPACE_HTTP_PERMISSION.GET is null),
//   which matches reading the live file: if you can open a file, you can see and
//   download its history. Restore, label and delete require MODIFY.
//
// So a read-only member is not "locked out of versions" — they get the read half
// and are refused the write half. Asserting only the refusals would let a
// regression that broke reading pass unnoticed, so both halves are here.
//
// The other two boundaries are different in kind and are asserted separately:
// a user who is not a member of the space cannot resolve the path at all (the
// guard answers before any versioning code runs), and the endpoints require a
// session — an unauthenticated caller never reaches them.
describe('versions permissions (e2e)', () => {
  let e2e: VersionsE2EContext
  let readOnly: VersionsActor
  let outsider: VersionsActor
  let spaceAlias: string
  let spaceId: number
  // updateSpace RECOMPUTES the alias from `name` and MOVES the space on disk when
  // it changes, so any later update has to pass the original name back verbatim.
  let spaceName: string
  let ownerApi: VersionsApi
  let readOnlyApi: VersionsApi
  let outsiderApi: VersionsApi

  const rel = 'e2e7-shared.txt'
  const ORIGINAL = 'the shared original content'
  const REPLACEMENT = 'the shared replacement content'

  beforeAll(async () => {
    e2e = await setupVersionsE2E()
    e2e.config.enabled = true
    e2e.config.minIntervalSeconds = 0

    readOnly = await e2e.addUser()
    outsider = await e2e.addUser()

    // A space owned/managed by the fixture user, with `readOnly` as a member
    // carrying NO operations. Empty permissions is exactly the read-only member:
    // membership grants access to the space, and the absence of MODIFY is what
    // the versions API checks before it will change anything.
    spaceName = `versions-e2e-${Date.now()}`
    const space = await e2e.app.get(SpacesManager).createSpace(e2e.user, {
      name: spaceName,
      enabled: true,
      storageQuota: null,
      storageIndexing: false,
      roots: [],
      managers: [{ id: e2e.user.id, type: MEMBER_TYPE.USER, spaceRole: SPACE_ROLE.IS_MANAGER, permissions: '' }],
      members: [
        {
          id: readOnly.user.id,
          type: MEMBER_TYPE.USER,
          spaceRole: SPACE_ROLE.IS_MEMBER,
          permissions: ''
        }
      ],
      links: []
    } as never)
    spaceAlias = space.alias
    spaceId = space.id

    // Seed a file in the space and overwrite it, so there is history to test
    // against. Written as the owner, through the real write path.
    const spaceFiles = SpaceModel.getFilesPath(spaceAlias)
    await fs.mkdir(spaceFiles, { recursive: true })
    await fs.writeFile(path.join(spaceFiles, rel), ORIGINAL)

    const spacesManager = e2e.app.get(SpacesManager)
    const ownerSpace = await spacesManager.spaceEnv(e2e.user, ['files', spaceAlias, rel])
    const { Readable } = await import('node:stream')
    await e2e.filesManager.saveStream(
      e2e.user,
      ownerSpace,
      { method: 'PUT', headers: {}, raw: Readable.from([REPLACEMENT]) } as never,
      {
        versionOrigin: 'web'
      } as never
    )

    const prefix = `files/${spaceAlias}`
    ownerApi = e2e.makeApiFor(e2e.session, prefix)
    readOnlyApi = e2e.makeApiFor({ cookie: readOnly.cookie, csrf: readOnly.csrf }, prefix)
    outsiderApi = e2e.makeApiFor({ cookie: outsider.cookie, csrf: outsider.csrf }, prefix)
  })

  afterAll(async () => await e2e?.teardown())

  /* ------------------------------------------------------- the owner’s view */

  it('the space manager can read AND write history', async () => {
    const list = await ownerApi.list(rel)
    expect(list.status).toBe(200)
    expect(list.body).toHaveLength(1)

    const [version] = list.body
    expect((await ownerApi.content(version.id, rel)).body).toBe(ORIGINAL)
    expect((await ownerApi.label(version.id, rel, 'owner named it')).status).toBe(200)
    expect((await ownerApi.label(version.id, rel, null)).status).toBe(200)
  })

  /* ------------------------------------------------ the read-only member’s */

  describe('a member with no operations', () => {
    it('CAN list and download history — GET carries no required permission', async () => {
      const list = await readOnlyApi.list(rel)
      expect(list.status).toBe(200)
      expect(list.body).toHaveLength(1)

      const content = await readOnlyApi.content(list.body[0].id, rel)
      expect(content.status).toBe(200)
      expect(content.body).toBe(ORIGINAL)

      // Usage and diff are reads too.
      expect((await readOnlyApi.usage(rel)).status).toBe(200)
      expect((await readOnlyApi.diff(list.body[0].id, rel)).status).toBe(200)
    })

    it('CANNOT restore, label or delete — those require MODIFY', async () => {
      const [version] = (await readOnlyApi.list(rel)).body

      // 403, not 404: the member can see the file, so hiding it would be a lie.
      expect((await readOnlyApi.restore(version.id, rel)).status).toBe(403)
      expect((await readOnlyApi.label(version.id, rel, 'nope')).status).toBe(403)
      expect((await readOnlyApi.remove(version.id, rel)).status).toBe(403)
    })

    it('leaves the file and its history untouched after being refused', async () => {
      // The refusals must be refusals, not partial writes.
      expect(await fs.readFile(path.join(SpaceModel.getFilesPath(spaceAlias), rel), 'utf8')).toBe(REPLACEMENT)
      const list = await ownerApi.list(rel)
      expect(list.body).toHaveLength(1)
      expect(list.body[0].label).toBeNull()
    })
  })

  /* ---------------------------------------------------------- the outsider */

  describe('a user who is not a member of the space', () => {
    // Different in kind from the read-only refusal: the guard cannot resolve the
    // path for someone with no access, so it answers before any versioning code
    // runs. 404 rather than 403 is deliberate — a 403 would confirm the file
    // exists.
    //
    // ASSERTED AS EXACTLY 404, not as `[403, 404]`. The disjunction this replaces
    // pinned nothing: it is satisfied by either guard answering, so the guest
    // block below could not have leant on it. The exact status is the whole
    // point of that contrast, and it is derivable rather than guessed — the
    // fixture's `addUser` grants every USER_PERMISSION, so `canAccessToSpaceUrl`
    // passes on `files/<alias>` (the SPACES permission) and the 403 branch of
    // SpaceGuard is never taken; `spacesQueries.permissions` then finds no row
    // for a non-member, `spaceEnv` returns null, and the guard throws
    // 'Space not found' with 404. Note that happens BEFORE the per-method
    // permission check, which is why the writes below answer 404 and not the
    // read-only member's 403.
    it('cannot reach the endpoints at all — 404, from path resolution', async () => {
      const [version] = (await ownerApi.list(rel)).body
      // Keyed by route so a failure names the one that diverged rather than
      // printing two anonymous arrays.
      expect({
        list: (await outsiderApi.list(rel)).status,
        usage: (await outsiderApi.usage(rel)).status,
        content: (await outsiderApi.content(version.id, rel)).status,
        diff: (await outsiderApi.diff(version.id, rel)).status,
        editorHistory: (await outsiderApi.editorHistory(rel)).status,
        restore: (await outsiderApi.restore(version.id, rel)).status,
        label: (await outsiderApi.label(version.id, rel, 'nope')).status,
        remove: (await outsiderApi.remove(version.id, rel)).status
      }).toEqual({ list: 404, usage: 404, content: 404, diff: 404, editorHistory: 404, restore: 404, label: 404, remove: 404 })
    })
  })

  /* ------------------------------------------- an external (guest) principal */

  // #492. The whole controller is gated on the USER role, so a principal below
  // it is refused before any path is resolved. The live file carries none of
  // what these endpoints serve — who edited it and when, and the BYTES of
  // earlier revisions, including content the sharer removed before sharing —
  // which is why "GET matches reading the live file" stops applying here.
  //
  // WHY A GUEST AND NOT A LINK, when a link is what the issue is about: a LINK
  // account cannot be driven end-to-end from here. `validateUserAccess` refuses
  // USER_ROLE.LINK at the login route outright; a link session exists only via
  // `GET /api/app/link/access/:uuid` against a reserved-UUID share. The gate
  // itself is one numeric comparison — `role <= USER_ROLE.USER` — so GUEST (2)
  // and LINK (3) fall on the same side of it, and the unit specs pin both.
  describe('a guest principal', () => {
    let guestApi: VersionsApi

    beforeAll(async () => {
      const guest = await e2e.addUser({ role: USER_ROLE.GUEST })
      guestApi = e2e.makeApiFor({ cookie: guest.cookie, csrf: guest.csrf }, `files/${spaceAlias}`)
    })

    // Asserted as EXACTLY 403, and contrasted with the outsider's EXACTLY 404 on
    // the same urls above, because that difference is the evidence the role guard
    // is in the request path at all: a guest is no more a member of this space
    // than the outsider is, so with the @UserHaveRole pair removed SpaceGuard
    // would refuse them for the same unrelated reason and answer the same 404.
    // The contrast only carries that weight because the outsider case now pins
    // one status instead of accepting either — with a disjunction there, both
    // cases would have stayed green through the gate's removal.
    it('is refused every read, by the role guard rather than by path resolution', async () => {
      const [version] = (await ownerApi.list(rel)).body

      expect((await guestApi.list(rel)).status).toBe(403)
      expect((await guestApi.usage(rel)).status).toBe(403)
      expect((await guestApi.content(version.id, rel)).status).toBe(403)
      expect((await guestApi.diff(version.id, rel)).status).toBe(403)
      expect((await guestApi.editorHistory(rel)).status).toBe(403)
    })

    // The writes are denied twice over: this controller's role guard, and
    // `requireInternalPrincipal` inside the service — which is what covers the
    // two controllers that do not sit behind the guard, NcVersionsController
    // reaching all three of these (MOVE / PROPPATCH / DELETE). Only the guard
    // half is observable from here; the backstop half is pinned in
    // versioning.service.spec.ts.
    it('is refused every write too, and the history is still standing afterwards', async () => {
      const [version] = (await ownerApi.list(rel)).body

      expect((await guestApi.restore(version.id, rel)).status).toBe(403)
      expect((await guestApi.label(version.id, rel, 'nope')).status).toBe(403)
      expect((await guestApi.remove(version.id, rel)).status).toBe(403)

      // A status code alone cannot tell "refused" from "refused after
      // destroying something" — so read the history back, as the owner.
      const list = await ownerApi.list(rel)
      expect(list.status).toBe(200)
      expect(list.body).toHaveLength(1)
      expect(list.body[0].label).toBeNull()
      expect(await fs.readFile(path.join(SpaceModel.getFilesPath(spaceAlias), rel), 'utf8')).toBe(REPLACEMENT)
    })
  })

  /* ------------------------- a guest WRITING in a shared space (#517) */

  // The central claim of #517, over real HTTP-adjacent plumbing rather than a
  // fake ensurer.
  //
  // WHY THIS CANNOT BE A UNIT TEST. The unit specs drive `snapshotBeforeOverwrite`
  // with a stubbed `FileRowEnsurer`, so they pin the PREDICATE (`mintsNoVersions`)
  // and nothing downstream of it. The real guest path continues into
  // `FileRowEnsurer.getOrCreateSpaceFile` -> upstream's
  // `assertValidFileReferenceId`, and that exact seam has failed silently
  // before: passing `0` there made versioning stop snapshotting ENTIRELY while
  // `nest build`, `ng lint` and every unit test stayed green, because the
  // ensurer returns 0 on any error by design. Only the e2e suite caught it.
  // Un-skipping a principal is precisely the change that could trip it again,
  // for a principal no other e2e writes as.
  //
  // WHY THE WRITE IS DRIVEN AT SERVICE LEVEL rather than through the versions
  // API: the versions controller is role-gated at USER (#492), so a guest is
  // 403 on every route above — which is the point. `filesManager.saveStream`
  // is the same entry point the fixture's own `overwrite()` uses and the one
  // a guest's browser PUT actually lands on.
  describe('a guest with MODIFY in a shared space', () => {
    let guest: VersionsActor
    let guestSpaceAlias: string
    const guestRel = 'e2e517-guest-write.txt'
    const BEFORE = 'the content the guest is about to destroy'
    const AFTER = 'what the guest wrote over it'

    beforeAll(async () => {
      guest = await e2e.addUser({ role: USER_ROLE.GUEST })
      // A guest is reachable as a space member ONLY through a manager. The
      // members whitelist (`usersQueries.usersWhitelist`) admits guests via
      // "all guests managed by the current user" and deliberately excludes
      // them from the ungrouped-users branch that lets the plain extra users
      // above be added. Without this, `updateMembers` filters the guest out
      // with a warning and `spaceEnv` then resolves to null — which looks
      // exactly like the feature being broken.
      //
      // Written through AdminUsersQueries rather than AdminUsersManager: the
      // manager-facing `updateUserOrGuest` reads the guest back first, and
      // that read selects FROM `users_guests`, so a guest with no manager row
      // yet is invisible to the very call that would give it one.
      await e2e.app.get(AdminUsersQueries).updateGuestManagers(guest.user.id, { add: [e2e.user.id], delete: [] })
      // usersWhitelist is cached for 30 minutes and the manager link was just
      // written underneath it. Cleared here rather than relied on: user
      // creation clears it with a fire-and-forget `void`.
      await e2e.app.get(UsersQueries).clearWhiteListCaches('*')

      const spacesManager = e2e.app.get(SpacesManager)
      // The guest is a member AT CREATION, not by a later updateSpace: space
      // permission changes are cached and a fresh grant is not necessarily
      // visible to the next request.
      const space = await spacesManager.createSpace(e2e.user, {
        name: `versions-e2e-guest-${Date.now()}`,
        enabled: true,
        storageQuota: null,
        storageIndexing: false,
        roots: [],
        managers: [{ id: e2e.user.id, type: MEMBER_TYPE.USER, spaceRole: SPACE_ROLE.IS_MANAGER, permissions: '' }],
        members: [
          {
            id: guest.user.id,
            type: MEMBER_TYPE.GUEST,
            spaceRole: SPACE_ROLE.IS_MEMBER,
            permissions: [SPACE_OPERATION.ADD, SPACE_OPERATION.MODIFY, SPACE_OPERATION.DELETE].sort().join(SPACE_PERMS_SEP)
          }
        ],
        links: []
      } as never)
      guestSpaceAlias = space.alias

      const spaceFiles = SpaceModel.getFilesPath(guestSpaceAlias)
      await fs.mkdir(spaceFiles, { recursive: true })
      await fs.writeFile(path.join(spaceFiles, guestRel), BEFORE)
    })

    it('mints a version under space:<alias>, holding the bytes it replaced', async () => {
      // If this ever stops being true the test proves nothing: the whole
      // question is what happens for a principal whose isGuest is set.
      expect(guest.user.isGuest).toBe(true)

      const spacesManager = e2e.app.get(SpacesManager)
      const guestSpace = await spacesManager.spaceEnv(guest.user, ['files', guestSpaceAlias, guestRel])
      expect(guestSpace).toBeTruthy()
      // The premise of the fix, asserted rather than assumed: this env resolves
      // to the SPACE's root, not to the guest's own user root — which is what
      // makes the tmpPath/usersPath objection inapplicable here.
      expect(guestSpace.alias).toBe(guestSpaceAlias)

      await e2e.filesManager.saveStream(
        guest.user,
        guestSpace,
        { method: 'PUT', headers: {}, raw: Readable.from([AFTER]) } as never,
        { versionOrigin: 'web' } as never
      )

      // Read back through VersioningQueries, never listVersions: that one is
      // gated on the feature flag AND denied to a guest, so it would answer
      // the wrong question either way. Scoped to a root this case owns, since
      // e2e files run in parallel worker threads against one database.
      const versionsRoot = `space:${guestSpaceAlias}`
      const fileIds = await e2e.versioningQueries.distinctFileIdsByRoot(versionsRoot)
      expect(fileIds).toHaveLength(1)

      const rows = await e2e.versioningQueries.byFileIdNewestFirst(versionsRoot, fileIds[0])
      expect(rows).toHaveLength(1)
      expect(rows[0].versionsRoot).toBe(versionsRoot)
      expect(rows[0].authorId).toBe(guest.user.id)
      expect(rows[0].size).toBe(BEFORE.length)

      // A row is not a version. The blob has to be there, under the SPACE's
      // store, and it has to hold the bytes the guest destroyed.
      const blob = path.join(SpaceModel.getHomePath(guestSpaceAlias), 'versions', rows[0].checksum.slice(0, 2), rows[0].checksum)
      expect(await fs.readFile(blob, 'utf8')).toBe(BEFORE)
      // And the live file really was overwritten — otherwise "the previous
      // content survives" would be true for an uninteresting reason.
      expect(await fs.readFile(path.join(SpaceModel.getFilesPath(guestSpaceAlias), guestRel), 'utf8')).toBe(AFTER)

      // Nothing landed in the guest's own user versions root. That tree lives
      // under usersPath while a guest's live files live under tmpPath, which is
      // the asymmetry the blanket skip existed to avoid; keying the skip on the
      // resolved root instead of on the account must not reintroduce it.
      const guestOwnStore = path.join(UserModel.getHomePath(guest.user.login), 'versions')
      const stray = await fs.readdir(guestOwnStore, { recursive: true }).catch(() => [] as string[])
      expect(stray.filter((n) => typeof n === 'string' && /^[0-9a-f]{2}\/[0-9a-f]{64}$/.test(n as string))).toEqual([])
    })
  })

  /* --------------------------------------------------------- no session */

  it('refuses an unauthenticated caller before any of this matters', async () => {
    const [version] = (await ownerApi.list(rel)).body
    const noCookie = await e2e.app.inject({
      method: 'GET',
      url: `/api/app/spaces/versions/content/${version.id}/files/${spaceAlias}/${rel}`
    } as never)
    expect([401, 403]).toContain(noCookie.statusCode)
  })

  /* ------------------------------------------------- the space versions root */

  // A space file's history lives under the SPACE's versions root, not the
  // acting user's — `space:<alias>`, a sibling of the space's files/ and trash/.
  // Getting this wrong would put one tenant's history inside another's home.
  it('stores a space file’s history under the space’s own versions root', async () => {
    const spaceVersions = path.join(SpaceModel.getHomePath(spaceAlias), 'versions')
    const entries = await fs.readdir(spaceVersions, { recursive: true }).catch(() => [] as string[])
    // At least one blob, and it is not in the owner's personal store.
    expect(entries.filter((n) => typeof n === 'string' && /^[0-9a-f]{2}\/[0-9a-f]{64}$/.test(n as string)).length).toBeGreaterThan(0)
    expect(spaceVersions.startsWith(SpaceModel.getFilesPath(spaceAlias))).toBe(false)

    const [version] = (await ownerApi.list(rel)).body
    expect(version.checksum).toMatch(/^[0-9a-f]{64}$/)
  })

  /* ------------------------------------------- a member WITH modify may write */

  it('a member granted MODIFY can restore, proving the refusal is about the permission', async () => {
    const writer = await e2e.addUser()
    const spacesManager = e2e.app.get(SpacesManager)

    await spacesManager.updateSpace(e2e.user, spaceId, {
      name: spaceName,
      enabled: true,
      storageQuota: null,
      storageIndexing: false,
      roots: [],
      managers: [{ id: e2e.user.id, type: MEMBER_TYPE.USER, spaceRole: SPACE_ROLE.IS_MANAGER, permissions: '' }],
      members: [
        { id: readOnly.user.id, type: MEMBER_TYPE.USER, spaceRole: SPACE_ROLE.IS_MEMBER, permissions: '' },
        {
          id: writer.user.id,
          type: MEMBER_TYPE.USER,
          spaceRole: SPACE_ROLE.IS_MEMBER,
          permissions: [SPACE_OPERATION.ADD, SPACE_OPERATION.MODIFY, SPACE_OPERATION.DELETE].sort().join(SPACE_PERMS_SEP)
        }
      ],
      links: []
    } as never)

    const writerApi = e2e.makeApiFor({ cookie: writer.cookie, csrf: writer.csrf }, `files/${spaceAlias}`)
    const list = await writerApi.list(rel)
    expect(list.status).toBe(200)

    const restore = await writerApi.restore(list.body[0].id, rel)
    expect(restore.status).toBe(201)
    expect(await fs.readFile(path.join(SpaceModel.getFilesPath(spaceAlias), rel), 'utf8')).toBe(ORIGINAL)
  })
})
