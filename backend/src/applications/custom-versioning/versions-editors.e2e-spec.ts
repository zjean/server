import { JwtService } from '@nestjs/jwt'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { configuration } from '../../configuration/config.environment'
import { OnlyOfficeManager } from '../files/editors/only-office/only-office-manager.service'
import { setupVersionsE2E, type VersionsE2EContext } from './utils/versions-e2e.fixture'

// Phase E, case E2E-11: the editor write path, end to end through a real
// callback.
//
// WHY THIS NEEDED CONFIG, not just code. `FilesModule` imports
// `OnlyOfficeModule` CONDITIONALLY at module-definition time
// (files.module.ts:28), so with `files.editors.onlyoffice.enabled` false
// `app.get(OnlyOfficeManager)` throws and the case cannot even resolve the
// service. Enabling it is therefore a prerequisite of the TEST, not a product
// change — which is why `environment.dev.dist.yaml` and the e2e workflow both
// turn it on with that reason written next to the flag.
//
// NO DOCUMENT SERVER RUNS. `saveDocument` downloads the "saved" document over
// HTTP from the url in the callback, and host validation only applies when
// `externalServer` is configured (only-office-manager.service.ts:444) — so a
// throwaway `node:http` server on 127.0.0.1 is a legitimate source. The callback
// itself is a JWT this spec signs with the configured secret, exactly as the
// document server would.
//
// WHAT THIS ADDS OVER THE UNIT SPEC. The hook's ordering (snapshot before
// copyFileContent) is already unit-tested. What only a real filesystem can show
// is the consequence the ADR actually cares about: the editor writes through
// `copyFileContent`, which truncates IN PLACE, so the live file's INODE survives
// a save — and that is the same fact that makes hardlinking a version blob
// unsound (ADR §1.1/§9, read from both ends).
describe('versions editor callbacks (e2e)', () => {
  let e2e: VersionsE2EContext
  let onlyOffice: OnlyOfficeManager
  let jwt: JwtService
  let secret: string
  let server: http.Server
  let origin: string
  // What the fake document server hands back on the next download.
  let servedContent = ''

  beforeAll(async () => {
    e2e = await setupVersionsE2E()

    // A clear failure here beats a confusing DI error: the flag is a documented
    // prerequisite of this spec.
    if (configuration.applications.files.editors.onlyoffice?.enabled !== true) {
      throw new Error(
        'versions editor e2e: applications.files.editors.onlyoffice.enabled must be true — FilesModule imports the module conditionally, see environment.dev.dist.yaml'
      )
    }
    onlyOffice = e2e.app.get(OnlyOfficeManager)
    jwt = e2e.app.get(JwtService)
    secret = configuration.applications.files.editors.onlyoffice.secret

    server = http.createServer((_req, res) => {
      const body = Buffer.from(servedContent)
      // saveDocument verifies the downloaded size against content-length and
      // throws on a mismatch, so this has to be honest.
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.byteLength) })
      res.end(body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    await e2e?.teardown()
  })

  beforeEach(() => {
    e2e.restoreConfig()
    e2e.config.enabled = true
    e2e.config.minIntervalSeconds = 0
    e2e.config.minIntervalSecondsByOrigin = { collabora: 0, onlyoffice: 0 } as never
  })

  // Drive the callback the way the document server does: a JWT carrying the
  // status and the download url.
  // `callBack` CATCHES everything and returns `{ error: <message> }`, so a test
  // that only checked side effects would report "no version was created" for a
  // callback that never ran. Assert the acknowledgement, and surface the message.
  const callback = async (rel: string, status: number, newContent: string, extra: Record<string, unknown> = {}) => {
    servedContent = newContent
    // The query params are NOT decoration. saveDocument reads `filename` to
    // decide whether the remote extension matches the local one (and to name its
    // temp file), so a url without it dies on `path.extname(null)` — and the
    // error is swallowed into `{ error: … }`. Keeping the extension equal to the
    // local file's also keeps the conversion branch out of the way.
    const url = `${origin}/cache/files/output.docx?md5=e2e-md5&expires=1739400549&shardkey=-33120641&filename=output.docx`
    const token = await jwt.signAsync({ status, url, actions: [], users: [], ...extra }, { secret })
    const result = await onlyOffice.callBack(e2e.user, await e2e.spaceEnv(rel), token)
    expect(result).toEqual({ error: 0 })
    return result
  }

  it('versions the pre-save content on a forcesave callback, tagged onlyoffice, with the acting author', async () => {
    const rel = 'e2e11-forcesave.docx'
    await e2e.seed(rel, 'the document as it was before the editor saved')

    // Status 6 is forcesave — one of the four statuses that reach saveDocument.
    await callback(rel, 6, 'the document the editor produced')

    const versions = await e2e.versionsOf(rel)
    expect(versions).toHaveLength(1)
    expect(versions[0].origin).toBe('onlyoffice')
    // The author arrives as a PARAMETER here, not on a request — there is no
    // req in an editor callback.
    expect(versions[0].author?.login).toBe(e2e.user.login)
    expect((await e2e.api.content(versions[0].id, rel)).body).toBe('the document as it was before the editor saved')
    expect(await fs.readFile(e2e.filesPath(rel), 'utf8')).toBe('the document the editor produced')
  })

  // THE ASSERTION ONLY A REAL FILESYSTEM CAN MAKE. Both editors deliberately use
  // copyFileContent rather than a move, with comments saying so, because trash
  // retention keys records on inodes and dbFileHash / file.id consumers depend
  // on inode stability. A save that replaced the inode would look like
  // delete+create to all of them.
  it('PRESERVES THE LIVE FILE’S INODE across an editor save', async () => {
    const rel = 'e2e11-inode.docx'
    await e2e.seed(rel, 'inode case before')
    const before = await fs.stat(e2e.filesPath(rel))

    await callback(rel, 6, 'inode case after, a different length entirely')

    const after = await fs.stat(e2e.filesPath(rel))
    expect(after.ino).toBe(before.ino)
    expect(after.size).not.toBe(before.size)
    expect(await e2e.versionsOf(rel)).toHaveLength(1)
  })

  // ADR §5's claim, made executable end to end rather than at the hook: only
  // statuses 2 (modified), 3, 6 and 7 reach saveDocument. There is no
  // autosave-per-keystroke path at all, which is why coalescing was expected to
  // rarely fire for this editor.
  it.each([
    [2, { notmodified: false }],
    [3, {}],
    [6, {}],
    [7, {}]
  ])('status %i produces a version', async (status, extra) => {
    const rel = `e2e11-status-${status}.docx`
    await e2e.seed(rel, `status ${status} before`)

    await callback(rel, status as number, `status ${status} after`, extra as Record<string, unknown>)

    const versions = await e2e.versionsOf(rel)
    expect(versions).toHaveLength(1)
    expect(versions[0].origin).toBe('onlyoffice')
  })

  it.each([
    [1, { actions: [{ type: 1, userid: '1' }], users: ['1'] }],
    [2, { notmodified: true }],
    [4, {}]
  ])('status %i produces no version and leaves the file alone', async (status, extra) => {
    const rel = `e2e11-nostatus-${status}.docx`
    await e2e.seed(rel, `status ${status} untouched`)

    await callback(rel, status as number, 'this must never be written', extra as Record<string, unknown>)

    expect(await e2e.versionsOf(rel)).toHaveLength(0)
    expect(await fs.readFile(e2e.filesPath(rel), 'utf8')).toBe(`status ${status} untouched`)
  })

  // D4's finding, end to end. The window is a RATE LIMIT, not a session
  // collapser, and the editor origins get their own 300s value precisely because
  // their cadence is the document server's rather than a human's.
  it('coalesces a second save inside the editor window, and mints a new version outside it', async () => {
    const rel = 'e2e11-coalesce.docx'
    e2e.config.minIntervalSecondsByOrigin = { collabora: 300, onlyoffice: 300 } as never
    await e2e.seed(rel, 'coalesce generation 0')

    await callback(rel, 6, 'coalesce generation 1')
    expect(await e2e.versionsOf(rel)).toHaveLength(1)

    // A second save moments later: the pre-session state is already captured.
    await callback(rel, 6, 'coalesce generation 2')
    expect(await e2e.versionsOf(rel)).toHaveLength(1)
    // And the one version still holds the PRE-SESSION bytes, not generation 1 —
    // which is the whole point of coalescing rather than replacing.
    expect((await e2e.api.content((await e2e.versionsOf(rel))[0].id, rel)).body).toBe('coalesce generation 0')

    // Outside the window, the next save is a new version.
    e2e.config.minIntervalSecondsByOrigin = { collabora: 0, onlyoffice: 0 } as never
    await callback(rel, 6, 'coalesce generation 3')
    expect(await e2e.versionsOf(rel)).toHaveLength(2)
  })

  // snapshotBeforeOverwrite swallows every failure by design: a failed snapshot
  // must degrade to "no version", never to a failed save. Proven here against the
  // real editor path rather than against a stub.
  it('still saves the document when the snapshot fails', async () => {
    const rel = 'e2e11-snapshot-failure.docx'
    await e2e.seed(rel, 'failure case before')

    const spy = vi.spyOn(e2e.versioningQueries, 'insertVersion').mockRejectedValueOnce(new Error('injected DB failure'))
    try {
      await callback(rel, 6, 'failure case after')
    } finally {
      spy.mockRestore()
    }

    expect(await fs.readFile(e2e.filesPath(rel), 'utf8')).toBe('failure case after')
    expect(await e2e.versionsOf(rel)).toHaveLength(0)
  })

  it('creates no version while the feature flag is off, and still saves', async () => {
    const rel = 'e2e11-flagoff.docx'
    await e2e.seed(rel, 'flag-off before')
    e2e.config.enabled = false

    await callback(rel, 6, 'flag-off after')

    expect(await fs.readFile(e2e.filesPath(rel), 'utf8')).toBe('flag-off after')
    expect(await e2e.versionsOf(rel)).toHaveLength(0)
  })
})
