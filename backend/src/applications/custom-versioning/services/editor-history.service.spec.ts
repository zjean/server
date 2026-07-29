// Config singleton must be mocked before UserModel / SpaceEnv read it at load.
// `auth.token.access.secret` is what the lifted ONLY_OFFICE token is verified
// against, and the editors block is what the version response is signed with.
vi.mock('../../../configuration/config.environment', () => ({
  configuration: {
    auth: { token: { access: { secret: 'access-secret' } } },
    applications: {
      files: {
        dataPath: '',
        usersPath: '',
        spacesPath: '',
        tmpPath: '',
        versions: { enabled: true },
        editors: {
          onlyoffice: { enabled: true, secret: 'doc-server-secret' },
          eurooffice: { enabled: false, secret: 'euro-secret' }
        }
      }
    }
  },
  serverConfig: {},
  exportConfiguration: vi.fn()
}))

import { HttpStatus } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Mock } from 'vitest'
import { TOKEN_TYPE } from '../../../authentication/interfaces/token.interface'
import { configuration } from '../../../configuration/config.environment'
import { Cache } from '../../../infrastructure/cache/cache.service'
import { ContextManager } from '../../../infrastructure/context/services/context-manager.service'
import { onlyOfficeDocKeyCacheKey } from '../../custom-shared/utils/only-office-doc-key'
import { FileError } from '../../files/models/file-error'
import { genEtag } from '../../files/utils/files'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { UserModel } from '../../users/models/user.model'
import type { VersionProps } from '../interfaces/version.interface'
import { EditorHistoryService } from './editor-history.service'
import { VersioningService } from './versioning.service'

// The adapter between our version rows and the OnlyOffice document server's
// history protocol.
//
// Everything asserted here is a contract of a THIRD PARTY's editor, verified
// against upstream ONLYOFFICE source rather than derived from our conventions —
// which is why it is worth pinning even where it looks obvious. Each case names
// the upstream citation and, where there is one, the failure it prevents.
describe(EditorHistoryService.name, () => {
  const FILE_ID = 4242
  const USER_ID = 7
  const user = { id: USER_ID, login: 'alice', fullName: 'Alice Anderson' } as unknown as UserModel

  let service: EditorHistoryService
  let versioning: { listVersions: Mock; restoreVersion: Mock }
  let cache: { get: Mock }
  let jwt: JwtService
  let tmpRoot: string
  let filePath: string
  let officeToken: string

  // Rows as listVersions hands them over: NEWEST FIRST, which is the order the
  // panel does not want.
  const rows = (...items: Partial<VersionProps>[]): VersionProps[] =>
    items.map(
      (over, index) =>
        ({
          id: 100 + index,
          fileId: FILE_ID,
          size: 10,
          mtime: 1_700_000_000_000,
          createdAt: new Date(),
          origin: 'onlyoffice',
          label: null,
          checksum: 'c'.repeat(64),
          ...over
        }) as VersionProps
    )

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-in-editor-history-'))
    filePath = path.join(tmpRoot, 'report.docx')
    await fs.writeFile(filePath, 'live content')

    versioning = { listVersions: vi.fn().mockResolvedValue([]), restoreVersion: vi.fn().mockResolvedValue(undefined) }
    cache = { get: vi.fn().mockResolvedValue(null) }

    const moduleRef = await Test.createTestingModule({
      providers: [
        EditorHistoryService,
        JwtService,
        { provide: VersioningService, useValue: versioning },
        { provide: Cache, useValue: cache },
        // headerOriginUrl is populated by ContextInterceptor. Returning a real
        // origin here is what lets the URL cases assert an ABSOLUTE url; the
        // interceptor's absence in production is a separate trap, covered by the
        // controller spec.
        { provide: ContextManager, useValue: { headerOriginUrl: () => 'https://files.example.test' } }
      ]
    }).compile()
    moduleRef.useLogger(['fatal'])
    service = moduleRef.get(EditorHistoryService)
    jwt = moduleRef.get(JwtService)

    officeToken = await jwt.signAsync(
      { tokenType: TOKEN_TYPE.ONLY_OFFICE, identity: { id: USER_ID, login: 'alice' } },
      { secret: 'access-secret', expiresIn: 3600 }
    )
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  const space = (over: Partial<SpaceEnv> = {}): SpaceEnv =>
    ({
      url: 'files/personal/docs/report.docx',
      realPath: filePath,
      dbFile: { id: FILE_ID, ownerId: USER_ID, path: 'docs/report.docx', inTrash: false },
      ...over
    }) as unknown as SpaceEnv

  /* ------------------------------------------------------------- history */

  // listByFileId orders desc(createdAt), desc(id) because every other consumer
  // wants newest-first. The panel's ordinal 1 is the OLDEST revision — upstream
  // reverses for exactly this reason (FileVersions::processVersionsArray is
  // array_reverse). Serving our order would number the history backwards and
  // make every `previous` in phase 2 point the wrong way.
  it('orders the history OLDEST first, reversing the domain order', async () => {
    versioning.listVersions.mockResolvedValue(rows({ id: 300, mtime: 3_000_000 }, { id: 200, mtime: 2_000_000 }, { id: 100, mtime: 1_000_000 }))

    const history = await service.history(user, space())

    expect(history.map((e) => e.version)).toEqual([1, 2, 3, 4])
    // Ordinal 1 is the oldest row, not the newest.
    expect(history[0].key).toBe(`${FILE_ID}_100`)
    expect(history[2].key).toBe(`${FILE_ID}_300`)
  })

  // editor.js:735 does `new Date(fileVersion.created * 1000)`; our rows hold
  // milliseconds. Without the divide every entry in the panel is dated to 1970.
  it('emits `created` in unix SECONDS, not the milliseconds the row holds', async () => {
    versioning.listVersions.mockResolvedValue(rows({ mtime: 1_700_000_123_456 }))

    const [entry] = await service.history(user, space())

    expect(entry.created).toBe(1_700_000_123)
  })

  // The editor treats the highest ordinal as "current" (EditorController.php
  // :930-940, and editor.js:728-745 derives currentVersion as the array
  // maximum). Omit it and the newest PAST revision is presented as the
  // document's present state — a panel that looks right and behaves wrongly.
  it('appends the LIVE FILE as the last entry, at ordinal count + 1', async () => {
    versioning.listVersions.mockResolvedValue(rows({ id: 200 }, { id: 100 }))
    const liveMtime = 1_777_000_000_000
    await fs.utimes(filePath, new Date(liveMtime), new Date(liveMtime))

    const history = await service.history(user, space())

    expect(history).toHaveLength(3)
    const live = history.at(-1)
    expect(live.version).toBe(3)
    expect(live.created).toBe(Math.floor(liveMtime / 1000))
    // NOT a `${fileId}_${id}` revision id — the live entry carries the document
    // key of the live content.
    expect(live.key).not.toContain('_')
  })

  it('is the live entry alone when the file has no history yet', async () => {
    const history = await service.history(user, space())

    expect(history).toHaveLength(1)
    expect(history[0].version).toBe(1)
  })

  // The ordinal must be contiguous and 1-based: the editor uses it as the
  // panel's identity and as the value it sends back for data and restore, so a
  // gap would make an entry unaddressable.
  it('numbers ordinals contiguously from 1 including the live entry', async () => {
    versioning.listVersions.mockResolvedValue(rows({ id: 5 }, { id: 4 }, { id: 3 }, { id: 2 }, { id: 1 }))

    const history = await service.history(user, space())

    expect(history.map((e) => e.version)).toEqual([1, 2, 3, 4, 5, 6])
  })

  /* ------------------------------------------------------------ revision id */

  // Design §3: the content checksum is wrong twice over. It is 64 characters, so
  // upstream's generateRevisionId crc32s it; and the blob store DEDUPS, so two
  // versions with identical bytes share one checksum and the panel would show
  // two rows the document server treats as ONE document.
  it('keys a version on `${fileId}_${versionId}`, never on the content checksum', async () => {
    const shared = 'd'.repeat(64)
    versioning.listVersions.mockResolvedValue(rows({ id: 200, checksum: shared }, { id: 100, checksum: shared }))

    const history = await service.history(user, space())

    expect(history[0].key).toBe(`${FILE_ID}_100`)
    expect(history[1].key).toBe(`${FILE_ID}_200`)
    // The point of the case: identical content, distinct revision ids.
    expect(history[0].key).not.toBe(history[1].key)
  })

  // generateRevisionId truncates to 20 characters over [0-9a-zA-Z.=_-]. Anything
  // longer is crc32'd, which reintroduces collision risk we are avoiding.
  it('produces a revision id inside upstream 20-character, restricted-charset budget', async () => {
    versioning.listVersions.mockResolvedValue(rows({ id: 999_999, fileId: 999_999 }))

    const [entry] = await service.history(user, space())

    expect(entry.key.length).toBeLessThanOrEqual(20)
    expect(entry.key).toMatch(/^[0-9a-zA-Z.=_-]+$/)
  })

  /* ------------------------------------------------------------------ user */

  it('carries the author as {id: login, name: fullName}', async () => {
    versioning.listVersions.mockResolvedValue(rows({ author: { login: 'bob', fullName: 'Bob Brown' } }))

    const [entry] = await service.history(user, space())

    // login, NOT authorId: listVersions does not expose authorId at all
    // (VersionProps carries `author?: {login, fullName}`).
    expect(entry.user).toEqual({ id: 'bob', name: 'Bob Brown' })
  })

  // A system-originated snapshot, or an author account since deleted (authorId
  // is ON DELETE SET NULL). Upstream falls back to the file's OWNER
  // (EditorController.php:913-920); we omit, because naming the owner as the
  // author of a write they may not have made is a false claim.
  it('OMITS `user` when the row has no author', async () => {
    versioning.listVersions.mockResolvedValue(rows({ author: undefined }))

    const [entry] = await service.history(user, space())

    expect('user' in entry).toBe(false)
  })

  // Nothing records who wrote the content that is live NOW: a version row's
  // author is the author of the SUPERSEDED content, so borrowing the newest
  // row's author would name the wrong person.
  it('omits `user` on the live entry even when history has authors', async () => {
    versioning.listVersions.mockResolvedValue(rows({ author: { login: 'bob', fullName: 'Bob Brown' } }))

    const history = await service.history(user, space())

    expect(history[0].user).toEqual({ id: 'bob', name: 'Bob Brown' })
    expect('user' in history.at(-1)).toBe(false)
  })

  /* ------------------------------------------------------- live document key */

  // The key the RUNNING editor session is already using, which the manager parked
  // in the cache when it answered /settings. Recomputing instead would be a
  // second answer to a question that already has one — and after a save the two
  // disagree, because the manager's key is frozen for the session while the
  // file's size/mtime have moved on.
  it('takes the live key from the cache the OnlyOffice manager wrote', async () => {
    cache.get.mockResolvedValue('cached-doc-key')

    const history = await service.history(user, space())

    expect(cache.get).toHaveBeenCalledWith(onlyOfficeDocKeyCacheKey(space().dbFile))
    expect(history.at(-1).key).toBe('cached-doc-key')
  })

  // A cache miss means no active session, so the manager's own expression is the
  // right answer — and it is what the manager would compute next. Deliberately
  // NOT written back: caching it here would fabricate a session key for a
  // session that does not exist.
  it('computes the live key with the manager expression on a cache miss, without caching it', async () => {
    const history = await service.history(user, space())

    expect(history.at(-1).key).toBe(genEtag(null, filePath, false))
    expect(cache).not.toHaveProperty('set')
  })

  /* ------------------------------------------------------------ versionData */

  it('answers one ordinal with the fileType, url, version and key', async () => {
    versioning.listVersions.mockResolvedValue(rows({ id: 100 }))

    const data = await service.versionData(user, space(), 1, officeToken)

    expect(data.fileType).toBe('docx')
    expect(data.version).toBe(1)
    expect(data.key).toBe(`${FILE_ID}_100`)
  })

  // The document server fetches this url server-to-server: no cookie, no CSRF
  // header. So it must be absolute, must address the route carrying
  // @OnlyOfficeEnvironment(), and must carry the ONLY_OFFICE JWT in `token`.
  it('builds a version url the DOCUMENT SERVER can fetch: absolute, editor-content route, token in the query', async () => {
    versioning.listVersions.mockResolvedValue(rows({ id: 100 }))

    const { url } = await service.versionData(user, space(), 1, officeToken)
    const parsed = new URL(url)

    expect(parsed.origin).toBe('https://files.example.test')
    expect(parsed.pathname).toContain('versions/editor-content/100')
    expect(parsed.searchParams.get('token')).toBe(officeToken)
  })

  // EditorController.php:1021-1025 — the ordinal one past the end is the live
  // file, and it is served by the EXISTING onlyoffice document route the running
  // session already reads.
  it('answers the live ordinal with the live document url and the live key', async () => {
    versioning.listVersions.mockResolvedValue(rows({ id: 100 }))
    cache.get.mockResolvedValue('cached-doc-key')

    const data = await service.versionData(user, space(), 2, officeToken)

    expect(new URL(data.url).pathname).toContain('onlyoffice/document')
    expect(data.key).toBe('cached-doc-key')
    expect(data.version).toBe(2)
  })

  // Phase 1 stores no changes archive, and the pair is only meaningful together:
  // the editor renders `previous`, then replays the archive over it
  // (EditorController.php:1045-1062). Emitting one without the other paints a
  // diff against content the archive was never recorded against.
  it('emits NEITHER changesUrl nor previous in phase 1', async () => {
    versioning.listVersions.mockResolvedValue(rows({ id: 200 }, { id: 100 }))

    const data = await service.versionData(user, space(), 2, officeToken)

    expect(data).not.toHaveProperty('changesUrl')
    expect(data).not.toHaveProperty('previous')
  })

  /* ---------------------------------------------------------------- signing */

  // DocsCoServer.js:2874 validates through fillVersionHistoryFromJwt and REJECTS
  // an unsigned response rather than ignoring the signature. So the failure mode
  // of forgetting this is "the panel opens and renders nothing".
  it('signs the whole response with the active editor secret, body and token claims agreeing', async () => {
    versioning.listVersions.mockResolvedValue(rows({ id: 100 }))

    const data = await service.versionData(user, space(), 1, officeToken)
    const claims: any = await jwt.verifyAsync(data.token, { secret: 'doc-server-secret' })

    expect(claims.key).toBe(data.key)
    expect(claims.url).toBe(data.url)
    expect(claims.version).toBe(data.version)
    expect(claims.fileType).toBe(data.fileType)
    // Upstream signs the result AFTER adding iat/exp, so the two are identical
    // (EditorController.php:1065-1071). jsonwebtoken keeps a payload's own iat
    // only when expiresIn is not also passed — this is what proves it was not.
    expect(claims.iat).toBe(data.iat)
    expect(claims.exp).toBe(data.exp)
    expect(data.exp).toBeGreaterThan(data.iat)
  })

  // Euro-Office is an OnlyOffice document server under another name, and
  // OnlyOfficeManager picks between the two configs at construction. Signing
  // with the wrong one fails only on a Euro-Office deployment, which is exactly
  // the install nobody tests on.
  it('signs with the EURO-OFFICE secret on a Euro-Office deployment', async () => {
    const editors = configuration.applications.files.editors as any
    editors.onlyoffice.enabled = false
    editors.eurooffice.enabled = true
    versioning.listVersions.mockResolvedValue(rows({ id: 100 }))

    const data = await service.versionData(user, space(), 1, officeToken)

    await expect(jwt.verifyAsync(data.token, { secret: 'euro-secret' })).resolves.toBeTruthy()
    editors.onlyoffice.enabled = true
    editors.eurooffice.enabled = false
  })

  // The converse of the rejection above: a document server started without
  // JWT_SECRET rejects a SIGNED payload just as firmly. Upstream guards the whole
  // signing block on a non-empty secret (EditorController.php:1064).
  it('omits the token entirely when no secret is configured', async () => {
    const editors = configuration.applications.files.editors as any
    editors.onlyoffice.secret = ''
    versioning.listVersions.mockResolvedValue(rows({ id: 100 }))

    const data = await service.versionData(user, space(), 1, officeToken)

    expect(data.token).toBeUndefined()
    expect(data.iat).toBeUndefined()
    editors.onlyoffice.secret = 'doc-server-secret'
  })

  /* ------------------------------------------------------------ office token */

  it('rejects a malformed editor token with a 400 rather than emitting a url that 401s', async () => {
    versioning.listVersions.mockResolvedValue(rows({ id: 100 }))

    await expect(service.versionData(user, space(), 1, 'not-a-jwt')).rejects.toMatchObject({
      httpCode: HttpStatus.BAD_REQUEST
    })
  })

  it('rejects a token of the wrong type', async () => {
    const accessToken = await jwt.signAsync(
      { tokenType: TOKEN_TYPE.ACCESS, identity: { id: USER_ID, login: 'alice' } },
      { secret: 'access-secret', expiresIn: 3600 }
    )
    versioning.listVersions.mockResolvedValue(rows({ id: 100 }))

    await expect(service.versionData(user, space(), 1, accessToken)).rejects.toMatchObject({ httpCode: HttpStatus.FORBIDDEN })
  })

  // The token ends up in a url the document server will fetch AS ITS BEARER. So
  // it has to belong to the caller — otherwise this endpoint would mint, for
  // anyone holding a leaked token, a fetch URL scoped to a path THEY chose.
  it("rejects another account's editor token", async () => {
    const othersToken = await jwt.signAsync(
      { tokenType: TOKEN_TYPE.ONLY_OFFICE, identity: { id: 99, login: 'mallory' } },
      { secret: 'access-secret', expiresIn: 3600 }
    )
    versioning.listVersions.mockResolvedValue(rows({ id: 100 }))

    await expect(service.versionData(user, space(), 1, othersToken)).rejects.toMatchObject({ httpCode: HttpStatus.FORBIDDEN })
  })

  /* --------------------------------------------------------------- ordinals */

  // Upstream reads ANY ordinal above the count as the live file
  // (EditorController.php:1021), so version 9999 of a two-version file silently
  // answers with the current document. The editor only ever sends ordinals it was
  // given, so an out-of-range one is a bug or a probe.
  it('404s an ordinal beyond the live entry instead of answering with the live file', async () => {
    versioning.listVersions.mockResolvedValue(rows({ id: 100 }))

    await expect(service.versionData(user, space(), 9999, officeToken)).rejects.toMatchObject({ httpCode: HttpStatus.NOT_FOUND })
  })

  it('404s ordinal 0 and negatives', async () => {
    versioning.listVersions.mockResolvedValue(rows({ id: 100 }))

    await expect(service.versionData(user, space(), 0, officeToken)).rejects.toBeInstanceOf(FileError)
    await expect(service.versionData(user, space(), -1, officeToken)).rejects.toBeInstanceOf(FileError)
  })

  /* ---------------------------------------------------------------- restore */

  // restoreVersion is where the pinned-descriptor rule, the createOrRefresh lock
  // rule and the document-key invalidation (#378) all live. A bespoke restore
  // here would silently drop all three — and the last one is what makes an
  // in-editor restore visible instead of the document server re-serving its own
  // cached copy.
  it('delegates restore to VersioningService with the ROW ID the ordinal maps to', async () => {
    versioning.listVersions.mockResolvedValue(rows({ id: 300 }, { id: 200 }, { id: 100 }))

    await service.restore(user, space(), 2)

    expect(versioning.restoreVersion).toHaveBeenCalledWith(user, expect.anything(), 200)
  })

  // editor.js:254-259 hands the restore response straight to refreshHistory, and
  // upstream's restore literally returns history($fileId)
  // (EditorController.php:1127). Returning nothing would leave the panel showing
  // the pre-restore state.
  it('returns the REFRESHED history so onRequestRestore can refresh the panel', async () => {
    versioning.listVersions.mockResolvedValue(rows({ id: 200 }, { id: 100 }))

    const history = await service.restore(user, space(), 1)

    expect(history.map((e) => e.version)).toEqual([1, 2, 3])
  })

  // "Restore the state the file is already in". Upstream ignores it the same way
  // (EditorController.php:1118 only rolls back when the ordinal is in range) and
  // the editor never offers Restore on the current entry.
  it('treats the live ordinal as a no-op rather than an error', async () => {
    versioning.listVersions.mockResolvedValue(rows({ id: 100 }))

    const history = await service.restore(user, space(), 2)

    expect(versioning.restoreVersion).not.toHaveBeenCalled()
    expect(history).toHaveLength(2)
  })

  it('404s a restore of an ordinal beyond the live entry', async () => {
    versioning.listVersions.mockResolvedValue(rows({ id: 100 }))

    await expect(service.restore(user, space(), 50)).rejects.toMatchObject({ httpCode: HttpStatus.NOT_FOUND })
    expect(versioning.restoreVersion).not.toHaveBeenCalled()
  })
})
