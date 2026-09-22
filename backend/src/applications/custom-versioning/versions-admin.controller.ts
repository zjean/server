import { Body, Controller, Get, Post, UseFilters, UseGuards } from '@nestjs/common'
import { USER_ROLE } from '../users/constants/user'
import { UserHaveRole } from '../users/decorators/roles.decorator'
import { UserRolesGuard } from '../users/guards/roles.guard'
import { VERSIONS_ROUTE } from './constants/routes'
import { PurgeVersionsRootDto, RepointVersionsRootDto } from './dto/version.dto'
import { VersioningExceptionsFilter } from './filters/versioning-exception.filter'
import { VersionsPurgeResult, VersionsRepointResult, VersionsStorageSummary } from './interfaces/version.interface'
import { VersionsAdminService } from './services/versions-admin.service'

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
// The routes carry no wildcard and their verbs ('admin/storage', 'admin/purge',
// 'admin/repoint') are distinct from every per-file verb, so they cannot be
// shadowed by the other controller's `versions/<verb>/*` patterns.
//
// THESE THREE ROUTES DELIBERATELY IGNORE `files.versions.enabled` (#490). Every
// per-file endpoint 404s with VERSIONS_DISABLED_MESSAGE while the feature is
// off (ADR §13) and should: there is no history to offer a user. These are not
// that. They are the operator's only instrument for the store that already
// exists, and the flag goes off *precisely* in the situation where it is
// needed — an operator disabling versioning because of a quota complaint, with
// the bytes still charged by the quota walk. 404ing here left `rm -rf` plus
// `DELETE FROM` as the only remedy, which is the surgery VersionsRetention
// .purgeRoot exists to make unnecessary. The reads report zeros on an empty
// store and both writes are idempotent, so none of them needs the flag to be
// meaningful.
@Controller(VERSIONS_ROUTE.BASE)
@UserHaveRole(USER_ROLE.ADMINISTRATOR)
@UseGuards(UserRolesGuard)
// FileError does not extend HttpException — without this filter the purge's
// 400 for a malformed root arrives as a 500. Same reason VersioningController
// has it.
@UseFilters(VersioningExceptionsFilter)
export class VersionsAdminController {
  constructor(private readonly admin: VersionsAdminService) {}

  @Get(`${VERSIONS_ROUTE.VERSIONS}/${VERSIONS_ROUTE.ADMIN}/${VERSIONS_ROUTE.STORAGE}`)
  async storage(): Promise<VersionsStorageSummary> {
    return this.admin.storageSummary()
  }

  // POST rather than DELETE: the request body names the target, and the action
  // is "purge this root's unnamed history", not "delete this resource" — the
  // root itself, its named versions and its blobs all survive.
  @Post(`${VERSIONS_ROUTE.VERSIONS}/${VERSIONS_ROUTE.ADMIN}/${VERSIONS_ROUTE.PURGE}`)
  async purge(@Body() dto: PurgeVersionsRootDto): Promise<VersionsPurgeResult> {
    return this.admin.purgeRoot(dto.versionsRoot)
  }

  // The repair for an unrepointed rename (#471), and the only action the
  // nightly sweep's error log can point an operator at.
  //
  // POST, like the purge, and for a stronger reason: it is neither a resource
  // creation nor a deletion but a rewrite of a discriminator across a set of
  // rows, and there is no resource whose URL it is. It is also the one write on
  // this controller that destroys nothing, which is why it carries no
  // confirmation flag — see VersionsAdminService.repointRoot.
  //
  // It ignores `files.versions.enabled` like its two siblings (#490). #530 first
  // shipped it behind requireEnabled(); that was written before #490 ungated this
  // controller and is incompatible with the reason the route exists. The nightly
  // sweep that DETECTS an unrepointed rename runs flag-off, and its error log
  // names this endpoint as the remedy — so gating it would point the operator at
  // a 404 in exactly the state the damage occurs.
  @Post(`${VERSIONS_ROUTE.VERSIONS}/${VERSIONS_ROUTE.ADMIN}/${VERSIONS_ROUTE.REPOINT}`)
  async repoint(@Body() dto: RepointVersionsRootDto): Promise<VersionsRepointResult> {
    return this.admin.repointRoot(dto.fromVersionsRoot, dto.toVersionsRoot)
  }
}
