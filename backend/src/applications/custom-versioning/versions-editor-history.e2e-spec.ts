import { JwtService } from '@nestjs/jwt'
import fs from 'node:fs/promises'
import { TOKEN_TYPE } from '../../authentication/interfaces/token.interface'
import { configuration } from '../../configuration/config.environment'
import { API_VERSIONS_EDITOR_VERSION } from './constants/routes'
import { setupVersionsE2E, type VersionsE2EContext } from './utils/versions-e2e.fixture'

// The OnlyOffice editor's version-history protocol, over real HTTP (#386).
//
// WHAT THIS ADDS OVER THE UNIT SPEC, which already covers the wire format
// exhaustively: the things a unit test cannot see because it stubs them.
//
//  1. THE AUTH MODEL. `editor-content` is the one versions route authenticated
//     by an ONLY_OFFICE token rather than a browser session, because the
//     DOCUMENT SERVER fetches it server-to-server. Whether the guard chain
//     actually accepts a token and actually refuses its absence is decided by
//     Nest wiring — metadata assertions prove the decorators are present, not
//     that the chain works.
//  2. THE ROUTE PATHS. The verb-before-id shape (`editor-version/:version/*`)
//     has to not collide with the wildcard routes next to it. A collision is a
//     404 or, worse, the wrong handler.
//  3. THAT THE URL WE HAND THE DOCUMENT SERVER IS ONE IT CAN ACTUALLY FETCH.
//     The unit spec asserts the url's SHAPE against a stubbed ContextManager;
//     only this can follow it and get bytes back.
//  4. THAT AN IN-EDITOR RESTORE REALLY REPLACES THE LIVE FILE.
//
// This spec needs an office editor enabled, for a structural reason rather than
// a behavioural one: `VersionsOfficeController` is mounted on the same either-or
// gate FilesModule uses to import OnlyOfficeModule, because its guard comes from
// there. With no editor enabled the route does not exist and cases 1/3 would
// report a 404 that reads like a feature bug. The e2e workflow enables onlyoffice
// for the same reason versions-editors.e2e-spec.ts needs it.
//
// EVERY ASSERTION IS SCOPED TO A FILE THIS CASE OWNS. The e2e files run in
// PARALLEL worker threads against ONE database (#366), so nothing here compares
// an instance-wide figure.
describe('versions editor history protocol (e2e)', () => {
  let e2e: VersionsE2EContext
  let officeToken: string
  let docServerSecret: string | null

  beforeAll(async () => {
    e2e = await setupVersionsE2E()

    const editors = configuration.applications.files.editors
    if (editors.onlyoffice?.enabled !== true && editors.eurooffice?.enabled !== true) {
      throw new Error(
        'versions editor-history e2e: an office editor must be enabled — VersionsOfficeController is mounted on that gate because OnlyOfficeGuard comes from OnlyOfficeModule, see custom-versioning.module.ts'
      )
    }
    docServerSecret = (editors.onlyoffice?.enabled ? editors.onlyoffice.secret : editors.eurooffice.secret) || null

    // The token the frontend lifts out of `config.document.url`. Minted here the
    // way OnlyOfficeManager.genAuthToken mints it: signed with the ACCESS secret
    // (not the document-server secret) and carrying tokenType ONLY_OFFICE, which
    // is what OnlyOfficeStrategy requires (only-office.strategy.ts:14-26).
    officeToken = await e2e.app.get(JwtService).signAsync(
      {
        tokenType: TOKEN_TYPE.ONLY_OFFICE,
        identity: {
          id: e2e.user.id,
          login: e2e.user.login,
          email: e2e.user.email,
          fullName: e2e.user.fullName,
          language: e2e.user.language,
          role: e2e.user.role,
          applications: e2e.user.applications
        }
      },
      { secret: configuration.auth.token.access.secret, expiresIn: 3600 }
    )
  })

  afterAll(async () => {
    await e2e?.teardown()
  })

  beforeEach(async () => {
    e2e.restoreConfig()
    e2e.config.enabled = true
    // Coalescing off: two successive writes must produce two versions or the
    // ordinal assertions below are measuring the window instead of the protocol.
    e2e.config.minIntervalSeconds = 0
    e2e.config.minIntervalSecondsByOrigin = { collabora: 0, onlyoffice: 0 } as never
  })

  // Three states, so ordinals 1, 2 and the live entry are all distinguishable by
  // content.
  //
  // A FILE PER CASE, never a shared one. History is cumulative and nothing here
  // resets the store between cases, so a shared path grows by two versions per
  // case and every ordinal assertion after the first drifts — which is exactly
  // how this spec failed on its first run. The counter also keeps each case's
  // assertions scoped to a file it alone owns, which is what the parallel-worker
  // rule (#366) asks for.
  let caseIndex = 0
  const seedThreeStates = async (): Promise<{ rel: string; rows: Awaited<ReturnType<VersionsE2EContext['versionsOf']>> }> => {
    const rel = `editor-history/report-${++caseIndex}.docx`
    await e2e.seed(rel, 'oldest')
    await e2e.overwrite(rel, 'middle', 'web')
    await e2e.overwrite(rel, 'live', 'web')
    const rows = await e2e.versionsOf(rel)
    // Guard the premise rather than discovering it through a confusing failure
    // three assertions later.
    expect(rows).toHaveLength(2)
    return { rel, rows }
  }

  /* --------------------------------------------------------------- history */

  it('serves the history oldest-first with the live file last', async () => {
    const { rel } = await seedThreeStates()

    const { status, body } = await e2e.api.editorHistory(rel)

    expect(status).toBe(200)
    expect(body.map((e) => e.version)).toEqual([1, 2, 3])
    // Ordinal 1 is the OLDEST revision, which is the reverse of the order the
    // list endpoint serves — assert against that endpoint so the two orders are
    // pinned relative to each other rather than in isolation.
    const newestFirst = (await e2e.api.list(rel)).body
    expect(body[0].key).toBe(`${newestFirst.at(-1).fileId}_${newestFirst.at(-1).id}`)
    expect(body[1].key).toBe(`${newestFirst[0].fileId}_${newestFirst[0].id}`)
  })

  it('dates the live entry from the live file, in unix seconds', async () => {
    const { rel } = await seedThreeStates()
    const stats = await fs.stat(e2e.filesPath(rel))

    const live = (await e2e.api.editorHistory(rel)).body.at(-1)

    expect(live.version).toBe(3)
    expect(live.created).toBe(Math.floor(stats.mtimeMs / 1000))
    // Seconds, not milliseconds: a value in ms would be ~1000x too large, which
    // the editor then multiplies by 1000 again.
    expect(String(live.created).length).toBeLessThanOrEqual(10)
  })

  it('is the live entry alone for a file with no history', async () => {
    await e2e.seed('editor-history/fresh.docx', 'only ever this')

    const { body } = await e2e.api.editorHistory('editor-history/fresh.docx')

    expect(body).toHaveLength(1)
    expect(body[0].version).toBe(1)
  })

  /* ----------------------------------------------------------- versionData */

  it('answers an ordinal with a signed payload whose claims match the body', async () => {
    const { rel } = await seedThreeStates()

    const { status, body } = await e2e.api.editorVersion(1, rel, officeToken)

    expect(status).toBe(200)
    expect(body.fileType).toBe('docx')
    expect(body.version).toBe(1)
    if (docServerSecret) {
      const claims: any = await e2e.app.get(JwtService).verifyAsync(body.token, { secret: docServerSecret })
      expect(claims.key).toBe(body.key)
      expect(claims.url).toBe(body.url)
    }
  })

  // The url has to be one the document server can actually fetch. Following it
  // here is the only assertion that proves the whole chain — absolute origin from
  // ContextInterceptor, a route that exists, and a guard chain that accepts the
  // token — rather than proving the string looks plausible.
  it('hands out a version url that really serves that revision, with no session', async () => {
    const { rel } = await seedThreeStates()
    const { body } = await e2e.api.editorVersion(1, rel, officeToken)
    const url = new URL(body.url)

    const fetched = await e2e.api.editorContent(Number(url.pathname.split('/').find((s) => /^\d+$/.test(s))), rel, url.searchParams.get('token'))

    expect(fetched.status).toBe(200)
    // Ordinal 1 is the OLDEST revision — the content the first overwrite
    // superseded.
    expect(fetched.body).toBe('oldest')
  })

  /* ------------------------------------------------------------ auth model */

  // The point of VersionsOfficeController existing at all. Without a token the
  // global AuthTokenAccessGuard has stood down (OnlyOfficeContext metadata) and
  // OnlyOfficeGuard is the only thing left to refuse the request — so if this
  // returned 200 the route would be flatly public.
  it('refuses the document-server route with NO token', async () => {
    const { rel, rows } = await seedThreeStates()

    const res = await e2e.api.editorContent(rows.at(-1).id, rel)

    expect(res.status).toBe(401)
  })

  it('refuses the document-server route with a token signed by the wrong secret', async () => {
    const { rel, rows } = await seedThreeStates()
    const forged = await e2e.app
      .get(JwtService)
      .signAsync({ tokenType: TOKEN_TYPE.ONLY_OFFICE, identity: { id: e2e.user.id, login: e2e.user.login } }, { secret: 'not-the-access-secret' })

    const res = await e2e.api.editorContent(rows.at(-1).id, rel, forged)

    expect(res.status).toBe(401)
  })

  // The browser-facing routes keep ordinary session auth, and `officeToken` is
  // NOT an alternative to it — it only decides what goes inside the url.
  it('still requires a session on the browser-facing version route', async () => {
    const { rel } = await seedThreeStates()

    // Built from the route constant, which ALREADY carries the api prefix —
    // hand-typing it produced a 404 that read like "the route refused me" when it
    // meant "no such route", the exact confusion the fixture's note (3) warns
    // about.
    const res = await e2e.app.inject({
      method: 'GET',
      url: `${API_VERSIONS_EDITOR_VERSION}/1/files/personal/${rel}?officeToken=${encodeURIComponent(officeToken)}`
    } as never)

    expect(res.statusCode).toBe(401)
  })

  it('rejects an office token belonging to another account', async () => {
    const { rel } = await seedThreeStates()
    const other = await e2e.addUser()
    const othersToken = await e2e.app
      .get(JwtService)
      .signAsync(
        { tokenType: TOKEN_TYPE.ONLY_OFFICE, identity: { id: other.user.id, login: other.user.login } },
        { secret: configuration.auth.token.access.secret, expiresIn: 3600 }
      )

    const { status } = await e2e.api.editorVersion(1, rel, othersToken)

    expect(status).toBe(403)
  })

  /* ---------------------------------------------------------------- restore */

  it('restores by ordinal, replacing the live content, and returns the refreshed history', async () => {
    const { rel } = await seedThreeStates()

    const { status, body } = await e2e.api.editorRestore(1, rel)

    expect(status).toBe(201)
    expect(await fs.readFile(e2e.filesPath(rel), 'utf8')).toBe('oldest')
    // A restore itself snapshots the content it replaced (ADR §4), so the history
    // is one entry longer than before: 3 versions + the live file.
    expect(body.map((e) => e.version)).toEqual([1, 2, 3, 4])
  })

  // Non-safe methods need the csrf header as well as the cookie, and this route
  // is a POST like every other write in this API.
  it('refuses an in-editor restore without the csrf header', async () => {
    const { rel } = await seedThreeStates()

    const { status } = await e2e.api.editorRestore(1, rel, { csrf: false })

    expect(status).toBe(403)
    expect(await fs.readFile(e2e.filesPath(rel), 'utf8')).toBe('live')
  })

  it('404s an ordinal beyond the live entry rather than answering with the live file', async () => {
    const { rel } = await seedThreeStates()

    expect((await e2e.api.editorVersion(99, rel, officeToken)).status).toBe(404)
    expect((await e2e.api.editorRestore(99, rel)).status).toBe(404)
    expect(await fs.readFile(e2e.filesPath(rel), 'utf8')).toBe('live')
  })

  /* ------------------------------------------------------------ feature flag */

  // The frontend probes once and latches `availability` one-way, so all four
  // routes have to agree the feature does not exist.
  it('404s every editor route while the feature flag is off', async () => {
    const { rel, rows } = await seedThreeStates()
    e2e.config.enabled = false

    expect((await e2e.api.editorHistory(rel)).status).toBe(404)
    expect((await e2e.api.editorVersion(1, rel, officeToken)).status).toBe(404)
    expect((await e2e.api.editorRestore(1, rel)).status).toBe(404)
    expect((await e2e.api.editorContent(rows.at(-1).id, rel, officeToken)).status).toBe(404)
  })
})
