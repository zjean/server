import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UseFilters,
  UseGuards
} from '@nestjs/common'
import { FastifyReply } from 'fastify'
import { fileName, getMimeType } from '../files/utils/files'
import { OverrideSpacePermission } from '../spaces/decorators/space-override-permission.decorator'
import { GetSpace } from '../spaces/decorators/space.decorator'
import { SPACE_OPERATION } from '../spaces/constants/spaces'
import { SpaceGuard } from '../spaces/guards/space.guard'
import { SpaceEnv } from '../spaces/models/space-env.model'
import { GetUser } from '../users/decorators/user.decorator'
import { UserModel } from '../users/models/user.model'
import { VERSIONS_ROUTE } from './constants/routes'
import { VERSIONS_DISABLED_MESSAGE, VERSIONS_MAX_DIFF_BYTES, VERSIONS_TEXTUAL_MIMES } from './constants/versioning'
import { DeleteVersionDto, SetVersionLabelDto, VersionDiffDto } from './dto/version.dto'
import { VersioningExceptionsFilter } from './filters/versioning-exception.filter'
import { VersionProps, VersionsUsage } from './interfaces/version.interface'
import { VersioningService } from './services/versioning.service'
import { DiffTooLargeError, unifiedDiff } from './utils/unified-diff'

// Version endpoints for the v2 UI.
//
// SpaceGuard is what authorizes every one of these: it resolves the trailing
// wildcard into a SpaceEnv, rejects a path the user cannot reach, and applies
// the HTTP-method permission rules. The service then re-checks that the version
// id actually belongs to the file that env points at, so a caller cannot reach
// another file's history by guessing ids.
//
// GET carries no required permission (SPACE_HTTP_PERMISSION.GET is null), which
// is deliberate and matches reading the live file: a read-only space member can
// list and download history but not restore, label or delete it.
@Controller(VERSIONS_ROUTE.BASE)
@UseGuards(SpaceGuard)
// Without this the service's FileError / LockConflict — permission denied,
// version not found, the named-delete 409, a locked file — all arrive as 500s,
// because neither type extends HttpException. See the filter for the full list.
@UseFilters(VersioningExceptionsFilter)
export class VersioningController {
  constructor(private readonly versioning: VersioningService) {}

  @Get(`${VERSIONS_ROUTE.VERSIONS}/${VERSIONS_ROUTE.LIST}/*`)
  async list(@GetUser() user: UserModel, @GetSpace() space: SpaceEnv): Promise<VersionProps[]> {
    this.requireEnabled()
    return this.versioning.listVersions(user, space)
  }

  // Backs the usage display ADR §7 makes a release blocker: enabling versioning
  // silently reduces effective quota by up to `quotaShare`, so that consumption
  // has to be visible.
  @Get(`${VERSIONS_ROUTE.VERSIONS}/${VERSIONS_ROUTE.USAGE}/*`)
  async usage(@GetUser() user: UserModel, @GetSpace() space: SpaceEnv): Promise<VersionsUsage> {
    this.requireEnabled()
    return this.versioning.versionsUsage(user, space)
  }

  @Get(`${VERSIONS_ROUTE.VERSIONS}/${VERSIONS_ROUTE.CONTENT}/:versionId/*`)
  async download(
    @GetUser() user: UserModel,
    @GetSpace() space: SpaceEnv,
    @Param('versionId', ParseIntPipe) versionId: number,
    @Res({ passthrough: true }) res: FastifyReply
  ): Promise<StreamableFile> {
    this.requireEnabled()
    const { stream, version } = await this.versioning.getVersionStream(user, space, versionId)
    const name = fileName(space.realPath)
    res.header('content-length', version.size)
    // `attachment` because this is an OLD revision — rendering it inline where
    // the user expects the current file would be actively misleading.
    res.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
    return new StreamableFile(stream, { type: getMimeType(space.realPath, false).replace('-', '/') })
  }

  // POST, but the acting permission is MODIFY, not ADD: a restore replaces the
  // content of an existing file. Without the override the guard would accept a
  // member who may only add new files.
  @Post(`${VERSIONS_ROUTE.VERSIONS}/${VERSIONS_ROUTE.RESTORE}/:versionId/*`)
  @OverrideSpacePermission(SPACE_OPERATION.MODIFY)
  async restore(@GetUser() user: UserModel, @GetSpace() space: SpaceEnv, @Param('versionId', ParseIntPipe) versionId: number): Promise<void> {
    this.requireEnabled()
    return this.versioning.restoreVersion(user, space, versionId)
  }

  @Patch(`${VERSIONS_ROUTE.VERSIONS}/${VERSIONS_ROUTE.LABEL}/:versionId/*`)
  async label(
    @GetUser() user: UserModel,
    @GetSpace() space: SpaceEnv,
    @Param('versionId', ParseIntPipe) versionId: number,
    @Body() dto: SetVersionLabelDto
  ): Promise<void> {
    this.requireEnabled()
    return this.versioning.setLabel(user, space, versionId, dto.label ?? null)
  }

  @Delete(`${VERSIONS_ROUTE.VERSIONS}/${VERSIONS_ROUTE.DELETE}/:versionId/*`)
  async remove(
    @GetUser() user: UserModel,
    @GetSpace() space: SpaceEnv,
    @Param('versionId', ParseIntPipe) versionId: number,
    @Query() dto: DeleteVersionDto
  ): Promise<void> {
    this.requireEnabled()
    return this.versioning.deleteVersion(user, space, versionId, dto.confirmLabeled === true)
  }

  // `against=current` (default) diffs the version against the live file;
  // `against=<id>` diffs two versions of the same file.
  @Get(`${VERSIONS_ROUTE.VERSIONS}/${VERSIONS_ROUTE.DIFF}/:versionId/*`)
  async diff(
    @GetUser() user: UserModel,
    @GetSpace() space: SpaceEnv,
    @Param('versionId', ParseIntPipe) versionId: number,
    @Query() dto: VersionDiffDto
  ): Promise<{ diff: string; identical: boolean }> {
    this.requireEnabled()
    const against = dto.against ?? 'current'

    const older = await this.readVersionText(user, space, versionId)
    const newer =
      against === 'current'
        ? { text: await this.readLiveText(space), label: 'current' }
        : await this.readVersionText(user, space, this.parseVersionId(against))

    try {
      return unifiedDiff(older.text, newer.text, older.label, newer.label)
    } catch (e) {
      if (e instanceof DiffTooLargeError) {
        throw new HttpException(e.message, HttpStatus.PAYLOAD_TOO_LARGE)
      }
      throw e
    }
  }

  private parseVersionId(raw: string): number {
    const id = Number.parseInt(raw, 10)
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new HttpException('`against` must be "current" or a version id', HttpStatus.BAD_REQUEST)
    }
    return id
  }

  private async readVersionText(user: UserModel, space: SpaceEnv, versionId: number): Promise<{ text: string; label: string }> {
    const { stream, version } = await this.versioning.getVersionStream(user, space, versionId)
    if (version.size > VERSIONS_MAX_DIFF_BYTES) {
      stream.destroy()
      throw new HttpException('This revision is too large to diff', HttpStatus.PAYLOAD_TOO_LARGE)
    }
    this.requireTextual(space)
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    return { text: Buffer.concat(chunks).toString('utf8'), label: `version ${version.id}` }
  }

  private async readLiveText(space: SpaceEnv): Promise<string> {
    this.requireTextual(space)
    const { stream, size } = await this.versioning.liveContent(space)
    if (size > VERSIONS_MAX_DIFF_BYTES) {
      stream.destroy()
      throw new HttpException('This file is too large to diff', HttpStatus.PAYLOAD_TOO_LARGE)
    }
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8')
  }

  // 415 for anything not text: a line diff of binary content is noise, and
  // decoding it as UTF-8 would produce replacement characters rather than an
  // honest error.
  private requireTextual(space: SpaceEnv): void {
    const mime = getMimeType(space.realPath, false)
    if (!mime.startsWith('text') && !VERSIONS_TEXTUAL_MIMES.has(mime)) {
      throw new HttpException('Only text files can be diffed', HttpStatus.UNSUPPORTED_MEDIA_TYPE)
    }
  }

  // Every endpoint 404s while the feature is off, so the v2 UI can probe once
  // and hide the whole panel rather than special-casing each call. The message
  // is a shared constant because the UI matches on it to tell this 404 apart
  // from SpaceGuard's 'Space not found'.
  private requireEnabled(): void {
    if (!this.versioning.enabled) {
      throw new HttpException(VERSIONS_DISABLED_MESSAGE, HttpStatus.NOT_FOUND)
    }
  }
}
