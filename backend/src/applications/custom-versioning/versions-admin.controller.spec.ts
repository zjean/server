import { ExecutionContext, HttpStatus, ValidationPipe } from '@nestjs/common'
import { EXCEPTION_FILTERS_METADATA, GUARDS_METADATA } from '@nestjs/common/constants'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { Mock } from 'vitest'
import { USER_ROLE } from '../users/constants/user'
import { UserHaveRole } from '../users/decorators/roles.decorator'
import { UserRolesGuard } from '../users/guards/roles.guard'
import { VERSIONS_DISABLED_MESSAGE } from './constants/versioning'
import { PurgeVersionsRootDto } from './dto/version.dto'
import { VersioningExceptionsFilter } from './filters/versioning-exception.filter'
import { VersioningService } from './services/versioning.service'
import { VersionsAdminService } from './services/versions-admin.service'
import { VersionsAdminController } from './versions-admin.controller'

describe(VersionsAdminController.name, () => {
  let controller: VersionsAdminController
  let admin: { storageSummary: Mock; purgeRoot: Mock }
  let versioning: { enabled: boolean }

  beforeEach(async () => {
    admin = {
      storageSummary: vi.fn().mockResolvedValue({ used: 0, labeledBytes: 0, count: 0, roots: 0, files: 0, topRoots: [] }),
      purgeRoot: vi.fn().mockResolvedValue({ versionsRoot: 'user:alice', removed: 0, removedBytes: 0, keptLabeled: 0 })
    }
    versioning = { enabled: true }

    const moduleRef = await Test.createTestingModule({
      controllers: [VersionsAdminController],
      providers: [
        { provide: VersionsAdminService, useValue: admin },
        { provide: VersioningService, useValue: versioning }
      ]
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
  })

  /* ------------------------------------------------------------ feature flag */

  // Same contract as every other versions endpoint (ADR §13), and with the same
  // shared message, so the panel can say "versioning is off here" instead of
  // rendering an empty table.
  it('404s with the shared message while the feature is off, and does no work', async () => {
    versioning.enabled = false

    await expect(controller.storage()).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND, message: VERSIONS_DISABLED_MESSAGE })
    await expect(controller.purge({ versionsRoot: 'user:alice' })).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND })

    expect(admin.storageSummary).not.toHaveBeenCalled()
    expect(admin.purgeRoot).not.toHaveBeenCalled()
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
})
