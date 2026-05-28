import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import fs from 'node:fs/promises'
import { ACTION } from '../../../common/constants'
import { DB_TOKEN_PROVIDER } from '../../../infrastructure/database/constants'
import type { DBSchema } from '../../../infrastructure/database/interfaces/database.interface'
import { FileEvent } from '../../files/events/file-events'
import type { FileEventType } from '../../files/interfaces/file-event.interface'
import type { FileProps } from '../../files/interfaces/file-props.interface'
import { filesRecents } from '../../files/schemas/files-recents.schema'
import { FilesQueries } from '../../files/services/files-queries.service'
import { dirName, fileName, getMimeType } from '../../files/utils/files'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { dbFileFromSpace } from '../../spaces/utils/paths'
import { UserModel } from '../../users/models/user.model'

// Recents-on-save: upsert a `files_recents` row whenever a file is added or
// updated, so OnlyOffice/Collabora/WebDAV/upload paths surface in /v2/recents
// without waiting for a subsequent browse() of the parent folder.
//
// Why this exists: upstream Sync-in only mutates `files_recents` as a
// side-effect of `SpacesBrowser.browse()` (spaces-browser.service.ts ~L70).
// Editing a file emits a `FileEvent` but no listener touches recents, so the
// v2 Recents screen (a prominent top-level destination) shows a stale list
// until the user happens to visit the parent folder. Combined with PR #163
// (which excludes negative-id rows from updateRecents), brand-new files never
// land in recents at all until something else materializes a `files` row.
//
// This service subscribes to the same global FileEvent emitter the
// FilesEventManager uses for quota/indexing, ensures the file has a real DB
// row via FilesQueries' public helpers, and upserts a single `files_recents`
// row keyed by (id, location).
//
// Pure-add: nothing in upstream gets edited. All paths live under
// custom-recents-touch/, mirroring the nc-sync-log subscriber pattern from
// custom-mobile-compat.

// Keep in sync with FilesRecents.keepTime ('14d') in files-recents.service.ts.
// Pre-filtering here avoids a stat + DB round-trip for events that would be
// dropped by the next browse-time reconciliation anyway.
const RECENTS_KEEP_MS = 14 * 24 * 60 * 60 * 1000

@Injectable()
export class RecentsTouchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RecentsTouchService.name)
  private listenerAttached = false
  // Held in a field (rather than an inline arrow) so OnModuleDestroy can
  // remove it. FileEvent is a process-global EventEmitter that outlives the
  // Nest module — without explicit removal we leak a closure (and the db /
  // filesQueries refs it captures) every time the module is recreated, which
  // happens on graceful shutdown, dev hot reload, and e2e test rebuilds.
  private readonly onEvent = (e: FileEventType): void => {
    this.handleFileEvent(e).catch((err: Error) => this.logger.warn({ tag: this.handleFileEvent.name, msg: err.message }))
  }

  constructor(
    @Inject(DB_TOKEN_PROVIDER) private readonly db: DBSchema,
    private readonly filesQueries: FilesQueries
  ) {}

  onModuleInit(): void {
    // Sync-in's FileEvent is a process-global singleton; only attach in
    // production paths so tests can opt in via attachListener() without
    // every spec inheriting our subscription.
    if (process.env.NODE_ENV === 'test') return
    this.attachListener()
  }

  onModuleDestroy(): void {
    if (!this.listenerAttached) return
    FileEvent.off('event', this.onEvent)
    this.listenerAttached = false
  }

  attachListener(): void {
    if (this.listenerAttached) return
    this.listenerAttached = true
    FileEvent.on('event', this.onEvent)
  }

  // Public so the spec can drive it directly without going through the
  // global emitter.
  async handleFileEvent(e: FileEventType): Promise<void> {
    if (!e?.user?.id || !e?.space) return
    if (e.action !== ACTION.ADD && e.action !== ACTION.UPDATE) return
    if (e.space.inTrashRepository) return
    if (e.space.inSharesList) return // shares-list browse, not a real file path

    let stats: import('node:fs').Stats
    try {
      stats = await fs.stat(e.rPath)
    } catch {
      // File may have been moved or deleted between emit and handler; nothing to do.
      return
    }
    if (stats.isDirectory()) return
    if (stats.size <= 0) return

    const mtime = stats.mtime.getTime()
    if (Date.now() - mtime > RECENTS_KEEP_MS) return // outside the 14-day retention window

    // Emit paths (OnlyOffice/Collabora/PUT/upload) all set space.url to the
    // *file*'s URL, not the parent folder's. dirName(space.url) therefore
    // produces the same `path` that browse-time updateRecents writes
    // (path = space.url, where in that flow space is the folder being
    // browsed). The match is what lets the UPDATE branch of the upsert find
    // rows previously written by browse().
    const baseName = fileName(e.space.url)
    const dirUrl = dirName(e.space.url)
    const mime = getMimeType(e.rPath, false)

    let fileId: number
    try {
      fileId = await this.ensureDbRow(e.user, e.space, { mtime, size: stats.size, mime, baseName })
    } catch (err) {
      this.logger.warn({ tag: this.handleFileEvent.name, msg: `ensureDbRow failed for ${e.space.url}: ${(err as Error).message}` })
      return
    }
    if (fileId <= 0) return

    await this.upsertRecent({
      fileId,
      space: e.space,
      userId: e.user.id,
      dirUrl,
      baseName,
      mime,
      mtime
    })
  }

  // Materialize a real `files` row for the event's target so its `id` passes
  // the `f.id > 0` filter on the next browse-time reconciliation, and so
  // click-through into v2 file-detail / preview / NC recommendations doesn't
  // 404 on the recents id. Path-keyed lookup-first prevents duplicate inserts
  // — getOrCreateUserFile does not do its own path lookup, only
  // getOrCreateSpaceFile does.
  private async ensureDbRow(user: UserModel, space: SpaceEnv, f: { mtime: number; size: number; mime: string; baseName: string }): Promise<number> {
    const dirInSpace = dirName(space.relativeUrl)
    const lookupProps: FileProps = {
      id: 0,
      path: dirInSpace,
      name: f.baseName,
      isDir: false,
      size: f.size,
      ctime: f.mtime,
      mtime: f.mtime,
      mime: f.mime
    }
    if (space.inPersonalSpace) {
      const existing = await this.filesQueries.getUserFileByPath(user.id, dirInSpace, f.baseName)
      if (existing !== null) return existing
      return this.filesQueries.getOrCreateUserFile(user.id, lookupProps)
    }
    const dbFile = dbFileFromSpace(user.id, space)
    const existing = await this.filesQueries.getSpaceFileId(lookupProps, dbFile)
    if (existing !== undefined && existing > 0) return existing
    return this.filesQueries.getOrCreateSpaceFile(0, lookupProps, dbFile)
  }

  // UPDATE-then-INSERT upsert. files_recents has no unique constraint we
  // could lean on for ON DUPLICATE KEY, and the (id, location) composite
  // already disambiguates rows in practice (a file id only ever lives in
  // one ownerId/spaceId/shareId column).
  private async upsertRecent(args: {
    fileId: number
    space: SpaceEnv
    userId: number
    dirUrl: string
    baseName: string
    mime: string
    mtime: number
  }): Promise<void> {
    const location = this.locationForUpsert(args.space, args.userId)
    if (!location) return

    const where = [eq(filesRecents.id, args.fileId)]
    if (location.ownerId !== undefined) where.push(eq(filesRecents.ownerId, location.ownerId))
    if (location.spaceId !== undefined) where.push(eq(filesRecents.spaceId, location.spaceId))
    if (location.shareId !== undefined) where.push(eq(filesRecents.shareId, location.shareId))

    const updateResult = await this.db
      .update(filesRecents)
      .set({ name: args.baseName, path: args.dirUrl, mime: args.mime, mtime: args.mtime })
      .where(and(...where))
      .limit(1)
    const affected =
      (updateResult as unknown as { rowsAffected?: number; affectedRows?: number }).rowsAffected ??
      (updateResult as unknown as { affectedRows?: number }).affectedRows ??
      0
    if (affected > 0) return

    await this.db.insert(filesRecents).values({
      id: args.fileId,
      ownerId: location.ownerId ?? null,
      spaceId: location.spaceId ?? null,
      shareId: location.shareId ?? null,
      path: args.dirUrl,
      name: args.baseName,
      mime: args.mime,
      mtime: args.mtime
    })
  }

  // Mirrors FilesRecents.getLocation for the single-file case. inSharesList
  // is unreachable here (gated above); the multi-share fan-out only matters
  // for the batched browse-time walk. inSharesRepository && id === 0 is
  // exactly inSharesList per SpaceEnv.setRepository — so when we reach the
  // share branch space.id is always truthy.
  private locationForUpsert(space: SpaceEnv, userId: number): { ownerId?: number; spaceId?: number; shareId?: number } | null {
    if (space.inPersonalSpace) return { ownerId: userId }
    if (space.inSharesRepository) return space.id ? { shareId: space.id } : null
    return space.id ? { spaceId: space.id } : null
  }
}
