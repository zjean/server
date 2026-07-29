import { HttpException, HttpStatus } from '@nestjs/common'
import { EXCEPTION_FILTERS_METADATA, GUARDS_METADATA, INTERCEPTORS_METADATA } from '@nestjs/common/constants'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { Readable } from 'node:stream'
import { Mock } from 'vitest'
import { ContextInterceptor } from '../../infrastructure/context/interceptors/context.interceptor'
import { ContextManager } from '../../infrastructure/context/services/context-manager.service'
import { ONLY_OFFICE_CONTEXT } from '../files/editors/only-office/only-office.constants'
import { OnlyOfficeGuard } from '../files/editors/only-office/only-office.guard'
import { SpaceGuard } from '../spaces/guards/space.guard'
import { SpaceEnv } from '../spaces/models/space-env.model'
import { UserModel } from '../users/models/user.model'
import { VERSIONS_DISABLED_MESSAGE } from './constants/versioning'
import { VersioningExceptionsFilter } from './filters/versioning-exception.filter'
import { VersioningService } from './services/versioning.service'
import { VersionsOfficeController } from './versions-office.controller'

// The route the DOCUMENT SERVER fetches, server-to-server.
//
// Most of what matters here is not behaviour but the SHAPE OF THE AUTH CHAIN,
// which is why most of these cases read decorator metadata. The behaviour is one
// delegation; the risk is a chain that looks right and authenticates nobody, and
// no unit test that calls the handler directly can see that.
describe(VersionsOfficeController.name, () => {
  let controller: VersionsOfficeController
  let versioning: { enabled: boolean; getVersionStream: Mock }

  const user = { id: 7, login: 'alice' } as unknown as UserModel
  const space = () => ({ realPath: '/data/users/alice/files/report.docx', url: 'files/personal/report.docx' }) as unknown as SpaceEnv
  const res = () => ({ header: vi.fn().mockReturnThis() }) as any

  beforeEach(async () => {
    versioning = {
      enabled: true,
      getVersionStream: vi.fn().mockResolvedValue({
        stream: Readable.from([Buffer.from('bytes')]),
        version: { id: 100, size: 5, origin: 'onlyoffice' }
      })
    }
    const moduleRef = await Test.createTestingModule({
      controllers: [VersionsOfficeController],
      providers: [
        { provide: VersioningService, useValue: versioning },
        // ContextInterceptor is part of @OnlyOfficeEnvironment(), and Nest
        // instantiates it to build the chain even though these cases call the
        // handler directly. In production ContextModule is @Global.
        { provide: ContextManager, useValue: { headerOriginUrl: () => 'https://files.example.test', run: (_c: any, cb: any) => cb() } }
      ]
    })
      .overrideGuard(OnlyOfficeGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(SpaceGuard)
      .useValue({ canActivate: () => true })
      .compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(VersionsOfficeController)
  })

  /* -------------------------------------------------------------- the chain */

  // OnlyOfficeGuard FIRST, then SpaceGuard. The order is the contract, not a
  // style choice: the token is what establishes who the caller is, and SpaceGuard
  // resolves and authorizes the path AS that caller. Reversed, SpaceGuard would
  // run with no user at all.
  it('guards with OnlyOfficeGuard then SpaceGuard, in that order', () => {
    const guards = new Reflector().get(GUARDS_METADATA, VersionsOfficeController.prototype.editorContent) ?? []
    expect(guards).toEqual([OnlyOfficeGuard, SpaceGuard])
  })

  // Without this metadata the GLOBAL AuthTokenAccessGuard runs and rejects the
  // document server's cookie-less request before either guard above is reached
  // (auth-token-access.guard.ts:20-22). The symptom would be a version panel
  // whose entries all render empty.
  it('carries the OnlyOffice context metadata that stands the global auth guard down', () => {
    expect(new Reflector().get(ONLY_OFFICE_CONTEXT, VersionsOfficeController.prototype.editorContent)).toBe(true)
  })

  it('carries ContextInterceptor, the third part of the composite', () => {
    const interceptors = new Reflector().get(INTERCEPTORS_METADATA, VersionsOfficeController.prototype.editorContent) ?? []
    expect(interceptors).toContain(ContextInterceptor)
  })

  // FileError does not extend HttpException, so without the filter every domain
  // error this route can raise — a version id belonging to another file, a blob
  // that eviction removed — reaches the document server as a 500.
  it('declares the exception filter', () => {
    expect(new Reflector().get(EXCEPTION_FILTERS_METADATA, VersionsOfficeController)).toContain(VersioningExceptionsFilter)
  })

  // The controller-level guard list must stay EMPTY. A guard added at class level
  // here would run before OnlyOfficeGuard for every handler — the exact reason
  // this route is not on VersioningController, which has a class-level SpaceGuard.
  it('declares no controller-level guards', () => {
    expect(new Reflector().get(GUARDS_METADATA, VersionsOfficeController)).toBeUndefined()
  })

  /* ------------------------------------------------------------- behaviour */

  it('streams the version with its recorded size', async () => {
    const file = await controller.editorContent(user, space(), 100, res())

    // The row id reaches the service, where requireVersionFor re-checks it
    // belongs to the resolved file — that check is what makes accepting an id in
    // the path safe.
    expect(versioning.getVersionStream).toHaveBeenCalledWith(user, expect.objectContaining({ url: 'files/personal/report.docx' }), 100)
    expect(file.options.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  })

  // No content-disposition: this response is consumed by the document server as a
  // document to render, not offered to a human as a file to save. The browser
  // download route sets `attachment` for the opposite reason.
  it('sets content-length but no content-disposition', async () => {
    const reply = res()
    await controller.editorContent(user, space(), 100, reply)

    const headers = reply.header.mock.calls.map(([name]: [string]) => name)
    expect(headers).toContain('content-length')
    expect(headers).not.toContain('content-disposition')
  })

  it('404s while the feature flag is off, without touching the store', async () => {
    versioning.enabled = false

    await expect(controller.editorContent(user, space(), 100, res())).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
      message: VERSIONS_DISABLED_MESSAGE
    })
    await expect(controller.editorContent(user, space(), 100, res())).rejects.toThrow(HttpException)
    expect(versioning.getVersionStream).not.toHaveBeenCalled()
  })
})
