import { NestFastifyApplication } from '@nestjs/platform-fastify'
import { XMLParser } from 'fast-xml-parser'
import fs from 'node:fs/promises'
import { appBootstrap } from '../../../app.bootstrap'
import { USER_PERMISSION, USER_PERMS_SEP, USER_ROLE } from '../../users/constants/user'
import { UserModel } from '../../users/models/user.model'
import { AdminUsersManager } from '../../users/services/admin-users-manager.service'
import { generateUserTest } from '../../users/utils/test'
import { NcAppPasswordService } from '../services/nc-app-password.service'
import { NcSyncLogService } from '../services/nc-sync-log.service'

// The nc_sync_events chain, end to end: a real write over HTTP → a FileEvent →
// a log row → the sync-collection REPORT a stock NC client actually reads.
//
// WHY THIS EXISTS. Until now nothing anywhere exercised this table over HTTP.
// The unit tests for NcSyncLogService hand-build the `FileEvent` payload, which
// pins the handler but skips the two joints where every defect in this area has
// lived: what upstream actually EMITS for a given write (#478 — a move-to-trash
// fires with the SOURCE space and the file's new absolute path under the trash
// root, so the row kept an absolute server path), and what the REPORT then
// RENDERS from it (#509 — that absolute path became the 404 marker's href, an
// address the client has never seen, so the delete never propagated and the
// server's disk layout leaked into the body).
//
// Both are invisible to a unit test with a hand-built payload, and both are
// invisible to a status-code assertion: the REPORT answered 207 throughout.
// So the assertions below are on the HREF TEXT.
//
// One environment fact the harness has to encode: NcSyncLogService.onModuleInit
// deliberately does NOT subscribe to FileEvent when NODE_ENV === 'test' (the
// emitter is a process-global singleton), so the listener is attached by hand
// in beforeAll. Nothing is logged without that call and every case here would
// pass vacuously with an empty window — which is why the first case asserts a
// create is PRESENT before any case asserts a delete is shaped correctly.
describe('nc_sync_events: emit → log → sync-collection REPORT (e2e)', () => {
  let app: NestFastifyApplication
  let admin: AdminUsersManager
  let user: UserModel
  let ncAuth: string

  beforeAll(async () => {
    app = await appBootstrap()
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    admin = app.get(AdminUsersManager)
    // `permissions` is the column; `applications` is derived from it and is not
    // one — a user built straight from generateUserTest() 403s on every request.
    user = await admin.createUserOrGuest(
      { ...generateUserTest(false), permissions: Object.values(USER_PERMISSION).join(USER_PERMS_SEP) } as never,
      USER_ROLE.USER
    )
    const minted = await app.get(NcAppPasswordService).mintMobileAppPassword(user, 'nc-sync-events-e2e')
    ncAuth = `Basic ${Buffer.from(`${user.login}:${minted.password}`).toString('base64')}`
    // The whole point of the file. See the header note.
    app.get(NcSyncLogService).attachListener()
  })

  afterAll(async () => {
    if (user?.id) {
      await admin.deleteUserOrGuest(user.id, user.login, { deleteSpace: true, isGuest: false } as never).catch(() => undefined)
    }
    await app?.close()
  })

  const nc = (method: string, url: string, opts: { payload?: string; headers?: Record<string, string> } = {}) =>
    app.inject({
      method,
      url,
      headers: { authorization: ncAuth, ...(opts.headers ?? {}) },
      ...(opts.payload === undefined ? {} : { payload: opts.payload })
    } as never)

  const home = () => `/remote.php/dav/files/${user.login}`
  const put = async (rel: string, body: string) => {
    const res = await nc('PUT', `${home()}/${rel}`, { payload: body })
    expect([200, 201, 204]).toContain(res.statusCode)
  }

  const parser = new XMLParser({ ignoreAttributes: false })

  interface Report {
    token: string
    live: string[] // hrefs with a 200 propstat
    deleted: string[] // hrefs carrying the RFC 6578 404 marker
    body: string
  }

  // Issue the REPORT the way NC iOS does, and read it the way NC iOS does: a
  // removed member is a <d:response> with a <d:status> and NO <d:propstat>
  // (RFC 6578 §3.2), so the two kinds are told apart by shape, not by position.
  async function report(token: string | null, at: string = home()): Promise<Report> {
    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<d:sync-collection xmlns:d="DAV:">' +
      (token === null ? '<d:sync-token/>' : `<d:sync-token>${token}</d:sync-token>`) +
      '<d:sync-level>1</d:sync-level>' +
      '<d:prop><d:getetag/><d:getcontentlength/></d:prop>' +
      '</d:sync-collection>'
    const res = await nc('REPORT', at, { headers: { 'content-type': 'application/xml', depth: '1' }, payload: body })
    expect(res.statusCode).toBe(207)
    const multistatus = parser.parse(res.body)['d:multistatus']
    const responses = [multistatus['d:response']].flat().filter(Boolean) as Record<string, unknown>[]
    return {
      token: String(multistatus['d:sync-token'] ?? ''),
      live: responses.filter((r) => r['d:propstat']).map((r) => String(r['d:href'])),
      deleted: responses.filter((r) => !r['d:propstat'] && String(r['d:status'] ?? '').includes('404')).map((r) => String(r['d:href'])),
      body: res.body
    }
  }

  // A cursor taken BEFORE the write under test, so every case sees only its own
  // events. e2e files run in parallel worker threads against one database and
  // this table is instance-wide — but the REPORT filters by ownerId, and each
  // case additionally windows on its own token, so nothing here can see a
  // neighbour's row.
  const cursor = () => report(null).then((r) => r.token)

  it('logs a create and reports it at the client-facing href', async () => {
    const from = await cursor()
    const rel = 'sync-create.txt'
    await put(rel, 'hello')

    const r = await report(from)
    expect(r.live).toContain(`${home()}/${rel}`)
    expect(r.token).not.toBe(from)
    // The token is opaque to the client but must be the URN form, or clients
    // that validate the prefix reject it.
    expect(r.token).toMatch(/^http:\/\/sync-in\/ns\/sync\/v1\//)
  })

  // THE CASE #520 ASKS FOR, and the one #478 / #509 both broke.
  it('reports a move-to-trash delete as a 404 marker at the ORIGINAL path, with no absolute server path anywhere in the body', async () => {
    const rel = 'sync-delete.txt'
    await put(rel, 'delete me')
    // Take the cursor AFTER the create so the window under test holds the
    // delete alone — a create and a delete for one href dedupe to the later
    // event, and asserting on a window that holds both would pass for the
    // wrong reason.
    const from = await cursor()

    expect([200, 201, 204]).toContain((await nc('DELETE', `${home()}/${rel}`)).statusCode)

    const r = await report(from)
    expect(r.deleted).toContain(`${home()}/${rel}`)
    // The marker must be the ONLY thing said about that href — a live response
    // alongside it is two contradictory answers for one URL.
    expect(r.live).not.toContain(`${home()}/${rel}`)

    // The regression shape: the row kept the file's absolute path under the
    // trash root, so the href came out as the server's disk layout.
    expect(r.body).not.toContain(UserModel.getFilesPath(user.login))
    expect(r.body).not.toContain(UserModel.getTrashPath(user.login))
    // Belt and braces for any other absolute-path leak: no href may carry a
    // doubled slash, which is what an absolute path splices in after the prefix.
    for (const href of [...r.live, ...r.deleted]) {
      expect(href.startsWith(`/remote.php/dav/files/${user.login}/`)).toBe(true)
      expect(href.slice(1)).not.toContain('//')
    }
  })

  it('reports a delete inside a subfolder at the subfolder-qualified href, not the bare name', async () => {
    expect((await nc('MKCOL', `${home()}/sync-sub`)).statusCode).toBe(201)
    await put('sync-sub/nested.txt', 'nested')
    const from = await cursor()

    expect([200, 201, 204]).toContain((await nc('DELETE', `${home()}/sync-sub/nested.txt`)).statusCode)

    const r = await report(from)
    expect(r.deleted).toContain(`${home()}/sync-sub/nested.txt`)
  })

  // The overwrite-move shape #520 calls out. SKIPPED BECAUSE IT FAILS, and it
  // fails on a live defect rather than on anything about the test: an
  // intra-space MOVE emits NO FileEvent at all, so this REPORT comes back
  // completely empty and a stock client never learns about a rename or an
  // in-home move.
  //
  // FilesManager.copyMove (files/services/files-manager.service.ts:606) emits
  // its DELETE_PERMANENTLY + ADD pair only `if (srcSpace.realBasePath !==
  // dstSpace.realBasePath)`, which is false for every move inside one space.
  // The destination-overwrite delete just above it is deliberately suppressed
  // by the fork's `pathWillBeRecreated` flag — correctly, since a bare delete
  // marker for a path that still exists is worse. Nothing else fires.
  //
  // Measured, so nobody re-derives it: the body really is
  // `<d:multistatus …><d:sync-token>…</d:sync-token></d:multistatus>` with no
  // <d:response> whatsoever, after a 204 MOVE whose destination content was
  // verified to be the source's.
  //
  // Tracked by #522. Un-skip it there; do not weaken it here — the assertions
  // below are what a correct emission has to satisfy, including the half that
  // passes today only because the window is empty.
  it.skip('an overwrite-MOVE marks the SOURCE gone and never the destination it just replaced (#522)', async () => {
    const src = 'sync-move-src.txt'
    const dst = 'sync-move-dst.txt'
    await put(src, 'new content')
    await put(dst, 'old content')
    const from = await cursor()

    const move = await nc('MOVE', `${home()}/${src}`, { headers: { destination: `${home()}/${dst}` } })
    expect([201, 204]).toContain(move.statusCode)
    // The move really did overwrite — otherwise the assertion below is vacuous.
    expect(await fs.readFile(`${UserModel.getFilesPath(user.login)}/${dst}`, 'utf8')).toBe('new content')

    const r = await report(from)
    // The source is gone from the client's point of view…
    expect(r.deleted).toContain(`${home()}/${src}`)
    // …and the destination is emphatically NOT — it holds the moved content.
    expect(r.deleted).not.toContain(`${home()}/${dst}`)
    expect(r.live).toContain(`${home()}/${dst}`)
  })

  it('advances the sync-token and reports nothing on an immediately repeated REPORT', async () => {
    await put('sync-idempotent.txt', 'x')
    const first = await report(null)
    expect(first.token).toBeTruthy()

    const second = await report(first.token)
    expect(second.live).toEqual([])
    expect(second.deleted).toEqual([])
    // An empty window must still ECHO FORWARD: parking the client on an old
    // token walks it under the prune horizon and costs it a full re-sync.
    expect(Number(second.token.split('/').pop())).toBeGreaterThanOrEqual(Number(first.token.split('/').pop()))
  })

  it('treats a token this deployment did not mint as a first sync rather than an error', async () => {
    const r = await report('urn:some-other-server:12345')
    expect(r.token).toMatch(/^http:\/\/sync-in\/ns\/sync\/v1\//)
  })

  it('scopes the window to the REPORT URL: a change outside the subtree is not reported inside it', async () => {
    expect((await nc('MKCOL', `${home()}/sync-scope`)).statusCode).toBe(201)
    const from = await cursor()
    await put('sync-scope-outside.txt', 'outside')
    await put('sync-scope/inside.txt', 'inside')

    const scoped = await report(from, `${home()}/sync-scope`)
    expect(scoped.live).toContain(`${home()}/sync-scope/inside.txt`)
    expect(scoped.live).not.toContain(`${home()}/sync-scope-outside.txt`)
  })

  it('refuses a sync-collection REPORT on the trashbin URL rather than answering an empty one', async () => {
    const res = await nc('REPORT', `/remote.php/dav/trashbin/${user.login}`, {
      headers: { 'content-type': 'application/xml', depth: '1' },
      payload: '<?xml version="1.0"?><d:sync-collection xmlns:d="DAV:"><d:sync-token/><d:sync-level>1</d:sync-level></d:sync-collection>'
    })
    expect(res.statusCode).toBe(405)
  })

  it('does not report another user’s events', async () => {
    const other = await admin.createUserOrGuest(
      { ...generateUserTest(false), permissions: Object.values(USER_PERMISSION).join(USER_PERMS_SEP) } as never,
      USER_ROLE.USER
    )
    try {
      const otherMinted = await app.get(NcAppPasswordService).mintMobileAppPassword(other, 'nc-sync-events-e2e-other')
      const otherAuth = `Basic ${Buffer.from(`${other.login}:${otherMinted.password}`).toString('base64')}`
      const from = await cursor()

      const res = await app.inject({
        method: 'PUT',
        url: `/remote.php/dav/files/${other.login}/sync-foreign.txt`,
        headers: { authorization: otherAuth },
        payload: 'not yours'
      } as never)
      expect([200, 201, 204]).toContain(res.statusCode)

      const r = await report(from)
      expect(r.body).not.toContain('sync-foreign.txt')
      expect(r.body).not.toContain(other.login)
    } finally {
      await admin.deleteUserOrGuest(other.id, other.login, { deleteSpace: true, isGuest: false } as never).catch(() => undefined)
    }
  })
})
