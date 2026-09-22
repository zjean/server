import { ExecutionContext, HttpStatus, ValidationPipe } from '@nestjs/common'
import { EXCEPTION_FILTERS_METADATA, GUARDS_METADATA } from '@nestjs/common/constants'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { Mock } from 'vitest'
import { USER_ROLE } from '../users/constants/user'
import { UserHaveRole } from '../users/decorators/roles.decorator'
import { UserRolesGuard } from '../users/guards/roles.guard'
import { PurgeVersionsRootDto, RepointVersionsRootDto } from './dto/version.dto'
import { VersioningExceptionsFilter } from './filters/versioning-exception.filter'
import { VersionsAdminService } from './services/versions-admin.service'
import { VersionsAdminController } from './versions-admin.controller'

describe(VersionsAdminController.name, () => {
  let controller: VersionsAdminController
  let admin: { storageSummary: Mock; purgeRoot: Mock; repointRoot: Mock }

  beforeEach(async () => {
    admin = {
      storageSummary: vi.fn().mockResolvedValue({ used: 0, labeledBytes: 0, count: 0, roots: 0, files: 0, topRoots: [] }),
      purgeRoot: vi.fn().mockResolvedValue({ versionsRoot: 'user:alice', removed: 0, removedBytes: 0, keptLabeled: 0 }),
      repointRoot: vi.fn().mockResolvedValue({ fromVersionsRoot: 'user:alice', toVersionsRoot: 'user:bob', moved: 0 })
    }
    const moduleRef = await Test.createTestingModule({
      controllers: [VersionsAdminController],
      providers: [{ provide: VersionsAdminService, useValue: admin }]
    })
      // The guard is exercised directly below rather than through the handlers.
      .overrideGuard(UserRolesGuard)
      .useValue({ canActivate: () => true })
      .compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(VersionsAdminController)
  })

  afterEach(() => vi.restoreAllMocks())

  /* --------------------------------------------------------------- delegation */

  it('delegates to the admin service', async () => {
    await controller.storage()
    expect(admin.storageSummary).toHaveBeenCalled()

    await controller.purge({ versionsRoot: 'user:alice' })
    expect(admin.purgeRoot).toHaveBeenCalledWith('user:alice')

    await controller.repoint({ fromVersionsRoot: 'user:alice', toVersionsRoot: 'user:bob' })
    expect(admin.repointRoot).toHaveBeenCalledWith('user:alice', 'user:bob')
  })

  /* ------------------------------------------------------------ feature flag */

  // #490. These two routes used to 404 with VERSIONS_DISABLED_MESSAGE while
  // `files.versions.enabled` was false, like every per-file endpoint (ADR §13).
  // That stranded the store: the flag goes off precisely when an operator is
  // chasing quota, and 404ing here left `rm -rf` + `DELETE FROM` as the only
  // way to reclaim bytes the quota walk still charges. The controller no longer
  // reads the flag at all, which is what this asserts — it takes no
  // VersioningService, so there is nothing left to consult.
  it('serves the operator surface regardless of the feature flag', async () => {
    await expect(controller.storage()).resolves.toBeDefined()
    await expect(controller.purge({ versionsRoot: 'user:alice' })).resolves.toBeDefined()

    await expect(controller.repoint({ fromVersionsRoot: 'user:alice', toVersionsRoot: 'user:bob' })).resolves.toBeDefined()

    expect(admin.storageSummary).toHaveBeenCalled()
    expect(admin.purgeRoot).toHaveBeenCalledWith('user:alice')
    expect(admin.repointRoot).toHaveBeenCalledWith('user:alice', 'user:bob')
  })

  /* ----------------------------------------------------------- authorization */

  // The purge is destructive and instance-wide, so the guard is the whole
  // authorization story here — there is no space path and therefore no
  // SpaceGuard. Assert the real guard's decision rather than only the metadata:
  // the metadata being present proves the decorator exists, the guard running
  // proves it denies.
  function ctxFor(haveRole: boolean): ExecutionContext {
    return {
      getHandler: () => VersionsAdminController.prototype.purge,
      getClass: () => VersionsAdminController,
      switchToHttp: () => ({ getRequest: () => ({ user: { haveRole: () => haveRole } }) })
    } as unknown as ExecutionContext
  }

  it('refuses a caller without the ADMINISTRATOR role and admits one with it', () => {
    const guard = new UserRolesGuard(new Reflector())
    expect(guard.canActivate(ctxFor(false))).toBe(false)
    expect(guard.canActivate(ctxFor(true))).toBe(true)
  })

  // Class-level on purpose: a route added later inherits the guard instead of
  // shipping open, which is the failure mode worth designing against on a
  // controller whose one write action cannot be undone.
  it('declares the role guard and the ADMINISTRATOR role at class level', () => {
    const reflector = new Reflector()
    expect(reflector.get(GUARDS_METADATA, VersionsAdminController)).toContain(UserRolesGuard)
    expect(reflector.get(UserHaveRole, VersionsAdminController)).toBe(USER_ROLE.ADMINISTRATOR)
  })

  it('declares the exception filter, so a malformed root is a 400 and not a 500', () => {
    expect(new Reflector().get(EXCEPTION_FILTERS_METADATA, VersionsAdminController)).toContain(VersioningExceptionsFilter)
  })

  /* -------------------------------------------------------------------- dto */

  // Bound to @Body(), so the real pipe is what decides whether a request even
  // reaches the service's own root validation.
  describe('PurgeVersionsRootDto', () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true })
    const parse = (body: Record<string, unknown>) => pipe.transform(body, { type: 'body', metatype: PurgeVersionsRootDto })

    it('accepts a root, including one at the full column width', async () => {
      await expect(parse({ versionsRoot: 'user:alice' })).resolves.toEqual({ versionsRoot: 'user:alice' })
      const longest = `space:${'x'.repeat(255)}`
      await expect(parse({ versionsRoot: longest })).resolves.toEqual({ versionsRoot: longest })
    })

    it('rejects a missing root and one longer than any root that can exist', async () => {
      await expect(parse({})).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST })
      await expect(parse({ versionsRoot: `space:${'x'.repeat(256)}` })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST })
    })

    // whitelist: true strips anything else, so a caller cannot smuggle extra
    // fields past the DTO into the service.
    it('strips unknown fields', async () => {
      await expect(parse({ versionsRoot: 'user:alice', includeLabeled: true })).resolves.toEqual({ versionsRoot: 'user:alice' })
    })
  })

  // The repair DTO (#471). Both ends are required — a repoint with one side
  // missing is not a partial repair, it is a request that cannot be satisfied.
  describe('RepointVersionsRootDto', () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true })
    const parse = (body: Record<string, unknown>) => pipe.transform(body, { type: 'body', metatype: RepointVersionsRootDto })

    it('accepts both roots, including at the full column width', async () => {
      await expect(parse({ fromVersionsRoot: 'user:alice', toVersionsRoot: 'user:bob' })).resolves.toEqual({
        fromVersionsRoot: 'user:alice',
        toVersionsRoot: 'user:bob'
      })
      const longest = `space:${'x'.repeat(255)}`
      await expect(parse({ fromVersionsRoot: longest, toVersionsRoot: 'space:team' })).resolves.toMatchObject({ fromVersionsRoot: longest })
    })

    it('rejects a missing end and one longer than any root that can exist', async () => {
      await expect(parse({ fromVersionsRoot: 'user:alice' })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST })
      await expect(parse({ toVersionsRoot: 'user:bob' })).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST })
      await expect(parse({ fromVersionsRoot: 'user:alice', toVersionsRoot: `space:${'x'.repeat(256)}` })).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST
      })
    })
  })
})
