import { HttpException, HttpStatus, ValidationPipe } from '@nestjs/common'
import { EXCEPTION_FILTERS_METADATA, INTERCEPTORS_METADATA } from '@nestjs/common/constants'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { Readable } from 'node:stream'
import { Mock } from 'vitest'
import { ContextInterceptor } from '../../infrastructure/context/interceptors/context.interceptor'
import { ContextManager } from '../../infrastructure/context/services/context-manager.service'
import { SPACE_OPERATION } from '../spaces/constants/spaces'
import { OverrideSpacePermission } from '../spaces/decorators/space-override-permission.decorator'
import { SpaceGuard } from '../spaces/guards/space.guard'
import { SpaceEnv } from '../spaces/models/space-env.model'
import { UserModel } from '../users/models/user.model'
import { VERSIONS_DISABLED_MESSAGE } from './constants/versioning'
import { DeleteVersionDto, EditorVersionDto } from './dto/version.dto'
import { VersioningExceptionsFilter } from './filters/versioning-exception.filter'
import { EditorHistoryService } from './services/editor-history.service'
import { VersioningService } from './services/versioning.service'
import { VersioningController } from './versioning.controller'

describe(VersioningController.name, () => {
  let controller: VersioningController
  let editorHistory: { history: Mock; versionData: Mock; restore: Mock }
  let versioning: {
    enabled: boolean
    listVersions: Mock
    versionsUsage: Mock
    getVersionStream: Mock
    restoreVersion: Mock
    setLabel: Mock
    deleteVersion: Mock
    liveContent: Mock
  }

  const user = { id: 7, login: 'alice' } as unknown as UserModel
  const res = () => ({ header: vi.fn().mockReturnThis() }) as any

  const textSpace = (realPath = '/data/users/alice/files/notes.txt') => ({ realPath, url: 'files/personal/notes.txt' }) as unknown as SpaceEnv

  function versionStream(text: string, id = 1) {
    return { stream: Readable.from([Buffer.from(text)]), version: { id, size: Buffer.byteLength(text), origin: 'web' } }
  }

  beforeEach(async () => {
    versioning = {
      enabled: true,
      listVersions: vi.fn().mockResolvedValue([]),
      versionsUsage: vi.fn().mockResolvedValue({ used: 0, ceiling: null, count: 0 }),
      getVersionStream: vi.fn(),
      restoreVersion: vi.fn().mockResolvedValue(undefined),
      setLabel: vi.fn().mockResolvedValue(undefined),
      deleteVersion: vi.fn().mockResolvedValue(undefined),
      liveContent: vi.fn()
    }
    editorHistory = {
      history: vi.fn().mockResolvedValue([]),
      versionData: vi.fn().mockResolvedValue({ fileType: 'docx', url: 'https://x/y', version: 1, key: '1_1' }),
      restore: vi.fn().mockResolvedValue([])
    }
    const moduleRef = await Test.createTestingModule({
      controllers: [VersioningController],
      providers: [
        { provide: VersioningService, useValue: versioning },
        { provide: EditorHistoryService, useValue: editorHistory },
        // ContextInterceptor is declared on editorVersion, and Nest instantiates
        // it to build the chain even though these cases call handlers directly.
        // In production ContextModule is @Global.
        { provide: ContextManager, useValue: { headerOriginUrl: () => 'https://files.example.test', run: (_c: any, cb: any) => cb() } }
      ]
    })
      // The guard is the authorization boundary and is exercised where it lives;
      // these cases call the handlers directly, so it is stubbed out. What is
      // still asserted here is the OverrideSpacePermission metadata the guard
      // reads — see the restore case below.
      .overrideGuard(SpaceGuard)
      .useValue({ canActivate: () => true })
      .compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(VersioningController)
  })

  /* --------------------------------------------------------------- delegation */

  it('lists and reports usage for the resolved space', async () => {
    await controller.list(user, textSpace())
    await controller.usage(user, textSpace())
    expect(versioning.listVersions).toHaveBeenCalledWith(user, expect.objectContaining({ url: 'files/personal/notes.txt' }))
    expect(versioning.versionsUsage).toHaveBeenCalled()
  })

  it('downloads a version as an attachment with the recorded size', async () => {
    versioning.getVersionStream.mockResolvedValue(versionStream('old bytes', 12))
    const reply = res()

    const file = await controller.download(user, textSpace(), 12, reply)

    expect(file).toBeDefined()
    expect(reply.header).toHaveBeenCalledWith('content-length', 9)
    // An OLD revision must not render inline where the user expects the
    // current file.
    const disposition = reply.header.mock.calls.find((c: unknown[]) => c[0] === 'content-disposition')?.[1]
    expect(disposition).toContain('attachment')
    expect(disposition).toContain('notes.txt')
  })

  it('passes the labeled-delete confirmation through', async () => {
    await controller.remove(user, textSpace(), 5, { confirmLabeled: true })
    expect(versioning.deleteVersion).toHaveBeenCalledWith(user, expect.anything(), 5, true)

    await controller.remove(user, textSpace(), 5, {})
    expect(versioning.deleteVersion).toHaveBeenLastCalledWith(user, expect.anything(), 5, false)
  })

  it('normalizes an omitted label to null (clearing it)', async () => {
    await controller.label(user, textSpace(), 5, {})
    expect(versioning.setLabel).toHaveBeenCalledWith(user, expect.anything(), 5, null)
  })

  // The handlers below call the service directly, so nothing here exercises how
  // its errors become HTTP responses — which is how "every FileError is a 500"
  // shipped green. The filter's own spec covers the mapping; this asserts the
  // controller still declares it, because losing the decorator restores the bug
  // silently.
  it('declares the exception filter that maps FileError and LockConflict', () => {
    const filters = new Reflector().get(EXCEPTION_FILTERS_METADATA, VersioningController)
    expect(filters).toContain(VersioningExceptionsFilter)
  })

  /* ------------------------------------------------------------- query dtos */

  // The cases above hand the handler a DTO object directly, which is exactly
  // how `?confirmLabeled=true` shipped broken: bound to @Query() the value
  // arrives as the string 'true', and the app's ValidationPipe does no implicit
  // conversion, so `@IsBoolean()` rejected it with a 400 — making a labeled
  // version undeletable. Run the real pipe against the real DTO here.
  describe('DeleteVersionDto over a query string', () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true })
    const parse = (query: Record<string, unknown>) => pipe.transform(query, { type: 'query', metatype: DeleteVersionDto })

    it('accepts the string forms a query string can carry', async () => {
      await expect(parse({ confirmLabeled: 'true' })).resolves.toEqual({ confirmLabeled: true })
      await expect(parse({ confirmLabeled: '1' })).resolves.toEqual({ confirmLabeled: true })
      await expect(parse({ confirmLabeled: 'false' })).resolves.toEqual({ confirmLabeled: false })
      await expect(parse({ confirmLabeled: '0' })).resolves.toEqual({ confirmLabeled: false })
    })

    it('leaves the flag absent when it is not supplied', async () => {
      await expect(parse({})).resolves.toEqual({})
    })

    // Coercion must not turn arbitrary junk into a truthy confirmation: an
    // unrecognized value stays itself and fails validation.
    it('rejects a value that is neither boolean nor a boolean string', async () => {
      await expect(parse({ confirmLabeled: 'yes' })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST })
    })
  })

  /* -------------------------------------------------------------- permissions */

  // The guard maps POST to ADD by default, which would let a member who may
  // only add new files replace an existing one. This metadata is what corrects
  // it, so assert the metadata rather than trusting the comment.
  it('declares MODIFY for restore, not the POST default of ADD', () => {
    const permission = new Reflector().get(OverrideSpacePermission, VersioningController.prototype.restore)
    expect(permission).toBe(SPACE_OPERATION.MODIFY)
  })

  /* -------------------------------------------------------------------- diff */

  it('diffs a version against the live file by default', async () => {
    versioning.getVersionStream.mockResolvedValue(versionStream('one\ntwo\n', 3))
    versioning.liveContent.mockResolvedValue({ stream: Readable.from([Buffer.from('one\nTWO\n')]), size: 8 })

    const { diff, identical } = await controller.diff(user, textSpace(), 3, {})

    expect(identical).toBe(false)
    expect(diff).toContain('-two')
    expect(diff).toContain('+TWO')
    expect(diff).toContain('+++ b/current')
  })

  it('diffs two versions of the same file when given an id', async () => {
    versioning.getVersionStream.mockResolvedValueOnce(versionStream('a\n', 3)).mockResolvedValueOnce(versionStream('b\n', 4))

    const { diff } = await controller.diff(user, textSpace(), 3, { against: '4' })

    expect(versioning.liveContent).not.toHaveBeenCalled()
    expect(diff).toContain('--- a/version 3')
    expect(diff).toContain('+++ b/version 4')
  })

  it('rejects a malformed `against`', async () => {
    versioning.getVersionStream.mockResolvedValue(versionStream('a\n', 3))
    await expect(controller.diff(user, textSpace(), 3, { against: 'latest' })).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST
    })
  })

  it('415s a non-text file rather than decoding bytes as UTF-8, without opening a stream', async () => {
    versioning.getVersionStream.mockResolvedValue(versionStream('\x00\x01', 3))
    await expect(controller.diff(user, textSpace('/data/users/alice/files/photo.jpg'), 3, {})).rejects.toMatchObject({
      status: HttpStatus.UNSUPPORTED_MEDIA_TYPE
    })
    // The mime check reads only the space, so it runs first. getVersionStream
    // returns a pinned descriptor and this path has no stream reference to
    // destroy, so acquiring one here would leak it on every 415.
    expect(versioning.getVersionStream).not.toHaveBeenCalled()
  })

  it('413s a revision above the diff size cap and does not leak the stream', async () => {
    const stream = Readable.from([Buffer.from('x')])
    const destroy = vi.spyOn(stream, 'destroy')
    versioning.getVersionStream.mockResolvedValue({ stream, version: { id: 3, size: 3 * 1024 * 1024 } })

    await expect(controller.diff(user, textSpace(), 3, {})).rejects.toMatchObject({ status: HttpStatus.PAYLOAD_TOO_LARGE })
    expect(destroy).toHaveBeenCalled()
  })

  /* ---------------------------------------------------------------- flag off */

  // The v2 UI probes once and hides the whole panel, so every endpoint has to
  // agree that the feature does not exist.
  it('404s every endpoint while the feature flag is off', async () => {
    versioning.enabled = false
    const space = textSpace()

    await expect(controller.list(user, space)).rejects.toThrow(HttpException)
    await expect(controller.usage(user, space)).rejects.toThrow(HttpException)
    await expect(controller.download(user, space, 1, res())).rejects.toThrow(HttpException)
    await expect(controller.restore(user, space, 1)).rejects.toThrow(HttpException)
    await expect(controller.label(user, space, 1, {})).rejects.toThrow(HttpException)
    await expect(controller.remove(user, space, 1, {})).rejects.toThrow(HttpException)
    await expect(controller.diff(user, space, 1, {})).rejects.toThrow(HttpException)
    // The editor-history routes are gated by the same probe: VersionsService's
    // one-way `availability` latch in the frontend keys on this 404, and it is
    // what keeps the panel out of the editor entirely while the flag is off.
    await expect(controller.editorHistory(user, space)).rejects.toThrow(HttpException)
    await expect(controller.editorVersion(user, space, 1, { officeToken: 't' })).rejects.toThrow(HttpException)
    await expect(controller.editorRestore(user, space, 1)).rejects.toThrow(HttpException)

    // The message, not just the status: these routes also 404 with 'Space not
    // found' from SpaceGuard, and the v2 service tells the two apart by
    // matching this exact constant. Changing the wording without changing the
    // constant would silently stop the UI from hiding the panel.
    await expect(controller.list(user, space)).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
      message: VERSIONS_DISABLED_MESSAGE
    })
    // Nothing reached the service.
    expect(versioning.listVersions).not.toHaveBeenCalled()
    expect(versioning.restoreVersion).not.toHaveBeenCalled()
    expect(editorHistory.history).not.toHaveBeenCalled()
    expect(editorHistory.restore).not.toHaveBeenCalled()
  })

  /* ---------------------------------------- the OnlyOffice history protocol */

  it('delegates the three editor-history routes to the adapter', async () => {
    const space = textSpace()

    await controller.editorHistory(user, space)
    await controller.editorVersion(user, space, 2, { officeToken: 'office-jwt' })
    await controller.editorRestore(user, space, 2)

    expect(editorHistory.history).toHaveBeenCalledWith(user, space)
    // The ordinal reaches the adapter unchanged, and the lifted token with it —
    // the adapter is where both are validated.
    expect(editorHistory.versionData).toHaveBeenCalledWith(user, space, 2, 'office-jwt')
    expect(editorHistory.restore).toHaveBeenCalledWith(user, space, 2)
  })

  // Same reason `restore` needs it: an in-editor restore replaces the content of
  // an existing file, so the POST default of ADD would let a member who may only
  // add new files overwrite one. Belt to the frontend's own VIEW-mode gate —
  // that gate hides the button, this one refuses the request.
  it('declares MODIFY for the in-editor restore too', () => {
    const permission = new Reflector().get(OverrideSpacePermission, VersioningController.prototype.editorRestore)
    expect(permission).toBe(SPACE_OPERATION.MODIFY)
  })

  // The urls in a version response must be ABSOLUTE, because the document server
  // fetches them itself. `headerOriginUrl()` is the only origin that is right
  // behind the reverse proxy and it is populated by ContextInterceptor — without
  // the interceptor it returns undefined and the panel silently gets
  // `undefined/files/...`. Asserted as metadata because the failure is invisible
  // in a unit test that stubs the context manager.
  it('declares ContextInterceptor on editorVersion, the one route that builds urls', () => {
    const interceptors = new Reflector().get(INTERCEPTORS_METADATA, VersioningController.prototype.editorVersion) ?? []
    expect(interceptors).toContain(ContextInterceptor)
  })

  describe('EditorVersionDto over a query string', () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true })
    const parse = (query: Record<string, unknown>) => pipe.transform(query, { type: 'query', metatype: EditorVersionDto })

    it('accepts the lifted office token', async () => {
      await expect(parse({ officeToken: 'a.b.c' })).resolves.toMatchObject({ officeToken: 'a.b.c' })
    })

    // A missing or empty token would otherwise produce a url the document server
    // 401s on, and the symptom — an empty panel — points nowhere near the cause.
    it('rejects an absent or empty token with a 400', async () => {
      await expect(parse({})).rejects.toThrow()
      await expect(parse({ officeToken: '' })).rejects.toThrow()
    })
  })
})
