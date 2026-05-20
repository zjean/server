import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { and, asc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm'
import { ACTION } from '../../../common/constants'
import { FileEvent } from '../../files/events/file-events'
import { DB_TOKEN_PROVIDER } from '../../../infrastructure/database/constants'
import type { DBSchema } from '../../../infrastructure/database/interfaces/database.interface'
import { SPACE_ALIAS, SPACE_REPOSITORY } from '../../spaces/constants/spaces'
import { spacesMembers } from '../../spaces/schemas/spaces-members.schema'
import { usersGroups } from '../../users/schemas/users-groups.schema'
import { ncSyncEvents } from '../schemas/nc-sync-events.schema'

// One-line summary of a Sync-in file mutation, normalized to the shape the
// NC sync-collection REPORT consumes. See
// docs/plans/2026-04-26-nc-sync-collection-design.md for protocol context.
export interface NcSyncEvent {
  id: number // doubles as the sync-token sequence
  ownerId: number
  repository: 'files' | 'trash'
  spaceAlias: string
  path: string
  type: 'create' | 'update' | 'delete'
  ts: number
}

// How many days of events we keep before pruning. Tokens older than this
// horizon get a 412 Precondition Failed; client falls back to a full sync.
const DEFAULT_KEEP_DAYS = 30

@Injectable()
export class NcSyncLogService implements OnModuleInit {
  private readonly logger = new Logger(NcSyncLogService.name)
  private listenerAttached = false

  constructor(@Inject(DB_TOKEN_PROVIDER) private readonly db: DBSchema) {}

  onModuleInit(): void {
    // Subscribe once. Sync-in's FileEvent is a process-global singleton so
    // we only attach in production paths; tests can opt in via
    // attachListenerForTests() rather than triggering on import.
    if (process.env.NODE_ENV === 'test') return
    this.attachListener()
  }

  attachListener(): void {
    if (this.listenerAttached) return
    this.listenerAttached = true
    FileEvent.on('event', (e) =>
      this.handleFileEvent(e).catch((err: Error) => this.logger.warn({ tag: this.handleFileEvent.name, msg: err.message }))
    )
  }

  // Append a new event. Public for direct unit testing + for the
  // implementation-time hooks if FileEvent ever misses a code path.
  async append(event: Omit<NcSyncEvent, 'id'>): Promise<void> {
    await this.db.insert(ncSyncEvents).values({
      ownerId: event.ownerId,
      repository: event.repository,
      spaceAlias: event.spaceAlias,
      path: event.path,
      type: event.type,
      ts: event.ts
    })
  }

  // Return events with `id > sinceId` for `ownerId`, optionally scoped to a
  // single space. Ordered by id ascending so the caller can stamp the last
  // returned id as the new sync-token. Empty array means "no changes".
  async since(opts: { ownerId: number; sinceId: number; spaceAlias?: string; limit?: number }): Promise<NcSyncEvent[]> {
    const conditions = [eq(ncSyncEvents.ownerId, opts.ownerId), gt(ncSyncEvents.id, opts.sinceId)]
    if (opts.spaceAlias) conditions.push(eq(ncSyncEvents.spaceAlias, opts.spaceAlias))
    const rows = await this.db
      .select()
      .from(ncSyncEvents)
      .where(and(...conditions))
      .orderBy(asc(ncSyncEvents.id))
      .limit(opts.limit ?? 500)
    return rows.map((r) => ({
      id: Number(r.id),
      ownerId: Number(r.ownerId),
      repository: r.repository as 'files' | 'trash',
      spaceAlias: r.spaceAlias,
      path: r.path,
      type: r.type as 'create' | 'update' | 'delete',
      ts: Number(r.ts)
    }))
  }

  // The most recent event id (for issuing the initial sync-token after a
  // full PROPFIND). Returns 0 when the log is empty.
  async currentToken(): Promise<number> {
    const [row] = await this.db.select({ max: sql<number>`MAX(${ncSyncEvents.id})` }).from(ncSyncEvents)
    return Number(row?.max ?? 0)
  }

  // Lowest event id still in the log (i.e. not yet pruned). Returns 0 when
  // the log is empty. The REPORT handler returns 412 Precondition Failed
  // for any token < minKeptToken so the client knows its sync horizon has
  // been forgotten and falls back to a full re-sync.
  async minKeptToken(): Promise<number> {
    const [row] = await this.db.select({ min: sql<number>`MIN(${ncSyncEvents.id})` }).from(ncSyncEvents)
    return Number(row?.min ?? 0)
  }

  // Drop events older than `keepDays`. Run from a daily cron in production.
  async prune(keepDays = DEFAULT_KEEP_DAYS): Promise<number> {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000
    const result = await this.db.delete(ncSyncEvents).where(lt(ncSyncEvents.ts, cutoff))
    // mysql2 driver returns { affectedRows } in the result header; surface it
    // for observability (cron logs).
    return (
      (result as unknown as { rowsAffected?: number; affectedRows?: number }).rowsAffected ??
      (result as unknown as { affectedRows?: number }).affectedRows ??
      0
    )
  }

  // Map a Sync-in FileEvent payload to one of our log rows.
  private async handleFileEvent(e: {
    user: { id: number }
    space: { id?: number; repository: string; alias?: string; realPath?: string; realBasePath?: string }
    action: ACTION
    rPath: string
  }): Promise<void> {
    if (!e?.user?.id || !e?.space) return
    const repository = e.space.repository === SPACE_REPOSITORY.TRASH ? 'trash' : 'files'
    const spaceAlias = e.space.alias ?? SPACE_ALIAS.PERSONAL
    const type = mapAction(e.action)
    if (!type) return
    // rPath is the absolute filesystem path; we only persist the path
    // relative to the space root (realBasePath) in the log. The REPORT
    // handler normalizes this back to a NC-style /remote.php/dav/files/<user>/...
    // href when it emits the response.
    //
    // We strip realBasePath rather than realPath because upstream emits
    // `rPath: space.realPath` (the file's full path). On a PUT to
    // /files/<user>/photos/cat.jpg the spaceEnv has paths=['photos','cat.jpg'],
    // so realPath === rPath and stripping realPath would yield ''. realBasePath
    // is the space root itself (e.g. /data/<user>/files), independent of the
    // request URL.
    const path = stripSpaceRealBasePathPrefix(e.rPath, e.space)
    const ts = Date.now()
    // Fan out to every user who can see the resource — the actor plus, for
    // shared spaces, the space's members (direct users + users in member
    // groups). Without this, a change A makes in B's shared space lands
    // under A's ownerId, so B's REPORT (filtering by their own ownerId)
    // never sees it and the mobile cache stays stale until a full refresh.
    const viewerIds = await this.resolveViewers(e.user.id, spaceAlias, e.space.id)
    for (const ownerId of viewerIds) {
      await this.append({ ownerId, repository, spaceAlias, path, type, ts })
    }
  }

  // Returns the set of userIds that can see resources in this space —
  // owner first, then space members (direct users + users in member groups),
  // deduplicated. Personal spaces resolve to just the actor.
  //
  // Public for test injection. The cost is one `spaces_members` query plus
  // one `users_groups` query when any group memberships exist; both run on
  // indexed columns so the realistic worst case (a space with 1k members) is
  // still sub-millisecond.
  async resolveViewers(actorId: number, spaceAlias: string, spaceId: number | undefined): Promise<number[]> {
    if (spaceAlias === SPACE_ALIAS.PERSONAL || !spaceId) {
      return [actorId]
    }
    const viewers = new Set<number>([actorId])
    const members = await this.db
      .select({ userId: spacesMembers.userId, groupId: spacesMembers.groupId })
      .from(spacesMembers)
      .where(and(eq(spacesMembers.spaceId, spaceId), or(sql`${spacesMembers.userId} IS NOT NULL`, sql`${spacesMembers.groupId} IS NOT NULL`)))
    const groupIds: number[] = []
    for (const m of members) {
      if (m.userId) {
        viewers.add(Number(m.userId))
      } else if (m.groupId) {
        groupIds.push(Number(m.groupId))
      }
    }
    if (groupIds.length > 0) {
      const groupMembers = await this.db.select({ userId: usersGroups.userId }).from(usersGroups).where(inArray(usersGroups.groupId, groupIds))
      for (const gm of groupMembers) {
        viewers.add(Number(gm.userId))
      }
    }
    return [...viewers]
  }
}

function mapAction(action: ACTION | undefined): NcSyncEvent['type'] | null {
  switch (action) {
    case ACTION.ADD:
      return 'create'
    case ACTION.UPDATE:
      return 'update'
    case ACTION.DELETE:
    case ACTION.DELETE_PERMANENTLY:
      return 'delete'
    default:
      return null
  }
}

function stripSpaceRealBasePathPrefix(rPath: string, space: { realBasePath?: string }): string {
  if (!space.realBasePath || !rPath.startsWith(space.realBasePath)) return rPath
  return rPath.slice(space.realBasePath.length).replace(/^\/+/, '')
}
