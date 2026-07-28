import { Body, Controller, Get, HttpException, HttpStatus, Post, UseFilters, UseGuards } from '@nestjs/common'
import { USER_ROLE } from '../users/constants/user'
import { UserHaveRole } from '../users/decorators/roles.decorator'
import { UserRolesGuard } from '../users/guards/roles.guard'
import { VERSIONS_ROUTE } from './constants/routes'
import { VERSIONS_DISABLED_MESSAGE } from './constants/versioning'
import { PurgeVersionsRootDto } from './dto/version.dto'
import { VersioningExceptionsFilter } from './filters/versioning-exception.filter'
import { VersionsPurgeResult, VersionsStorageSummary } from './interfaces/version.interface'
import { VersionsAdminService } from './services/versions-admin.service'
import { VersioningService } from './services/versioning.service'

// Instance-wide version storage endpoints for operators (#342).
//
// A SEPARATE CONTROLLER FROM VersioningController, on purpose. Every route there
// addresses a file through a trailing wildcard and is authorized by SpaceGuard
// resolving that path. These address the whole store: there is no path to
// resolve, so SpaceGuard has nothing to authorize and must not be in the chain.
// Authorization is the ADMINISTRATOR role instead — the same
// @UserHaveRole + UserRolesGuard pair the content-indexing endpoints use
// (files.controller.ts), which is the existing pattern for "server-level
// maintenance, admins only". No new authorization path is invented here.
//
// Both decorators sit at CLASS level. UserRolesGuard reads the role with
// getAllAndOverride([handler, class]), so a route added later inherits the guard
// instead of shipping unauthenticated — which is the failure mode worth
// designing against on a controller whose one write action is destructive.
// Authentication itself is the global APP_GUARD (AuthTokenAccessGuard).
//
// The routes carry no wildcard and their verbs ('admin/storage', 'admin/purge')
// are distinct from every per-file verb, so they cannot be shadowed by the other
// controller's `versions/<verb>/*` patterns.
@Controller(VERSIONS_ROUTE.BASE)
@UserHaveRole(USER_ROLE.ADMINISTRATOR)
@UseGuards(UserRolesGuard)
// FileError does not extend HttpException — without this filter the purge's
// 400 for a malformed root arrives as a 500. Same reason VersioningController
// has it.
@UseFilters(VersioningExceptionsFilter)
export class VersionsAdminController {
  constructor(
    private readonly admin: VersionsAdminService,
    private readonly versioning: VersioningService
  ) {}

  @Get(`${VERSIONS_ROUTE.VERSIONS}/${VERSIONS_ROUTE.ADMIN}/${VERSIONS_ROUTE.STORAGE}`)
  async storage(): Promise<VersionsStorageSummary> {
    this.requireEnabled()
    return this.admin.storageSummary()
  }

  // POST rather than DELETE: the request body names the target, and the action
  // is "purge this root's unnamed history", not "delete this resource" — the
  // root itself, its named versions and its blobs all survive.
  @Post(`${VERSIONS_ROUTE.VERSIONS}/${VERSIONS_ROUTE.ADMIN}/${VERSIONS_ROUTE.PURGE}`)
  async purge(@Body() dto: PurgeVersionsRootDto): Promise<VersionsPurgeResult> {
    this.requireEnabled()
    return this.admin.purgeRoot(dto.versionsRoot)
  }

  // Same contract as every other versions endpoint: 404 with the shared message
  // while `files.versions.enabled` is false (ADR §13), so the admin panel can
  // tell "the feature is off here" apart from any other 404 and say so instead
  // of showing an empty table.
  private requireEnabled(): void {
    if (!this.versioning.enabled) {
      throw new HttpException(VERSIONS_DISABLED_MESSAGE, HttpStatus.NOT_FOUND)
    }
  }
}
