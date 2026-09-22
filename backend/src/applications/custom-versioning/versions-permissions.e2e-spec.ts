// reflect-metadata FIRST: this spec imports space models before the fixture, and
// those transitively evaluate class-validator/class-transformer decorators on
// files.config.ts. Every other e2e spec happens to import @nestjs/platform-fastify
// (which loads the shim) before anything decorated; relying on that accident is
// what produces 'Reflect.getMetadata is not a function' at collection time.
import 'reflect-metadata'
import fs from 'node:fs/promises'
import path from 'node:path'
import { SpaceModel } from '../spaces/models/space.model'
import { SpacesManager } from '../spaces/services/spaces-manager.service'
import { MEMBER_TYPE } from '../users/constants/member'
import { USER_ROLE } from '../users/constants/user'
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
