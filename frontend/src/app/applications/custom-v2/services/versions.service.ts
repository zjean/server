import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { inject, Injectable, signal } from '@angular/core'
import {
  API_VERSIONS_CONTENT,
  API_VERSIONS_DELETE,
  API_VERSIONS_DIFF,
  API_VERSIONS_LABEL,
  API_VERSIONS_LIST,
  API_VERSIONS_RESTORE,
  API_VERSIONS_USAGE
} from '@sync-in-server/backend/src/applications/custom-versioning/constants/routes'
import { VERSIONS_DISABLED_MESSAGE } from '@sync-in-server/backend/src/applications/custom-versioning/constants/versioning'
import type { SetVersionLabelDto } from '@sync-in-server/backend/src/applications/custom-versioning/dto/version.dto'
import { encodeUrl } from '@sync-in-server/backend/src/common/shared'
import { map, Observable, tap } from 'rxjs'
import { downloadWithAnchor } from '../../../common/utils/functions'
import { DiffTarget, toVersionModels, VersionApiProps, VersionDiff, VersionModel, VersionsUsage } from '../models/version.model'

// Whether this server has file versioning turned on. `unknown` until the first
// list/usage answers — see `availability` below for why it is not just a boolean.
export type VersionsAvailability = 'unknown' | 'available' | 'unavailable'

/**
 * File version history for custom-v2.
 *
 * Every endpoint addresses a file by its Sync-in space path — the same
 * `<repository>/<alias>/<segments>/<name>` string the files APIs take (e.g.
 * `files/personal/notes/todo.md`) — carried in a trailing route wildcard that
 * `SpaceGuard` resolves into the space env and authorizes. Callers pass the
 * plain, decoded path; this service encodes it.
 *
 * Authorization is entirely server-side and follows reading vs writing the live
 * file: GET (list, usage, download, diff) needs no particular permission, so a
 * read-only member can inspect and download history, while restore, label and
 * delete require MODIFY.
 */
@Injectable({ providedIn: 'root' })
export class VersionsService {
  private readonly http = inject(HttpClient)

  /**
   * Whether the feature is on, so a caller can hide its whole panel instead of
   * showing an error for a feature that does not exist here.
   *
   * `files.versions.enabled` defaults to false and is env/yaml-only — there is
   * no config endpoint to ask, and by design every version endpoint 404s while
   * it is off. A bare status check is not enough to conclude that, because these
   * routes also 404 with 'Space not found' when SpaceGuard cannot resolve the
   * path. So the distinguishing signal is the message, matched against the
   * backend constant this file imports — no duplicated string, and the backend
   * spec pins the wording.
   *
   * Latching is one-way on purpose: any success sets `available`, and only an
   * answer that holds for the whole session sets `unavailable` — a feature-off
   * 404, or a 403 from the role gate. A per-file failure never disables the panel
   * globally. See `noteAvailability` for why those two and nothing else.
   */
  readonly availability = signal<VersionsAvailability>('unknown')

  /**
   * Settles `availability` by making one real call, discarding its result.
   *
   * A host that decides whether to show a versions affordance at all cannot wait
   * for the panel to mount and tell it — the panel lives inside the thing being
   * shown. So the host probes, once per session: this no-ops as soon as
   * `availability` is settled, which makes it safe to call on every file open.
   *
   * `usage` is the probe because it is a single aggregate query and its answer is
   * root-scoped, so nothing about it depends on the path being a particular file.
   */
  probe(spacePath: string): void {
    if (this.availability() !== 'unknown') return
    this.usage(spacePath).subscribe({ next: () => undefined, error: () => undefined })
  }

  list(spacePath: string): Observable<VersionModel[]> {
    return this.http
      .get<VersionApiProps[]>(`${API_VERSIONS_LIST}/${encodeUrl(spacePath)}`)
      .pipe(tap({ next: () => this.availability.set('available'), error: (e) => this.noteAvailability(e) }), map(toVersionModels))
  }

  /**
   * Versions bytes and the quota ceiling they are capped at.
   *
   * Scoped to the versions ROOT (the user's home or the space), not to the file
   * in the path — the file only tells the guard which root to resolve. So the
   * same numbers come back for every file in a space, and they are the right
   * numbers to show next to a space's storage usage.
   */
  usage(spacePath: string): Observable<VersionsUsage> {
    return this.http
      .get<VersionsUsage>(`${API_VERSIONS_USAGE}/${encodeUrl(spacePath)}`)
      .pipe(tap({ next: () => this.availability.set('available'), error: (e) => this.noteAvailability(e) }))
  }

  /**
   * URL serving a version's bytes. Public because a non-text comparison opens
   * the old revision in the v2 viewer rather than diffing it.
   *
   * The response is `Content-Disposition: attachment` and carries the LIVE
   * file's name — deliberately, so an old revision is never rendered inline
   * where the current file is expected.
   */
  contentUrl(spacePath: string, versionId: number): string {
    return `${API_VERSIONS_CONTENT}/${versionId}/${encodeUrl(spacePath)}`
  }

  // Session cookies carry the request, so an anchor download needs no token —
  // the same mechanism classic uses for `FileModel.dataUrl`.
  download(spacePath: string, versionId: number, downloadName = ''): void {
    downloadWithAnchor(this.contentUrl(spacePath, versionId), downloadName)
  }

  /**
   * Replaces the live file's content with this version's.
   *
   * Not destructive: the backend snapshots the current content first (as origin
   * `restore`), so the state being replaced stays restorable in turn.
   *
   * It also takes a server lock, so this answers **423 LOCKED** when someone
   * else is editing the file — the repo's convention for a lock conflict. Your
   * own lock does not block you, which matters because the editor holds one on
   * any file open in the very screen that offers this.
   */
  restore(spacePath: string, versionId: number): Observable<void> {
    return this.http.post<void>(`${API_VERSIONS_RESTORE}/${versionId}/${encodeUrl(spacePath)}`, null)
  }

  // A blank or whitespace-only label clears the name; the backend trims and
  // normalizes it to null, so `''` and `null` are the same request.
  setLabel(spacePath: string, versionId: number, label: string | null): Observable<void> {
    const dto: SetVersionLabelDto = { label }
    return this.http.patch<void>(`${API_VERSIONS_LABEL}/${versionId}/${encodeUrl(spacePath)}`, dto)
  }

  /**
   * Deletes one version and drops its blob when nothing else references it.
   *
   * Deleting a NAMED version requires `confirmLabeled` — without it the backend
   * answers 409 rather than deleting, because a named revision is exempt from
   * every automatic pruning rule and losing one to a mis-click is unrecoverable.
   * Ask the user first, then repeat the call with the flag.
   */
  remove(spacePath: string, versionId: number, confirmLabeled = false): Observable<void> {
    return this.http.delete<void>(`${API_VERSIONS_DELETE}/${versionId}/${encodeUrl(spacePath)}`, {
      params: confirmLabeled ? { confirmLabeled: true } : {}
    })
  }

  /**
   * Unified diff of a version against the live file (the default) or against
   * another version of the same file.
   *
   * Text only, and capped at 2 MB per side: the backend answers 415 for a
   * non-text mime and 413 above the cap. Both are expected outcomes for a
   * "compare" affordance offered on any file, not failures to log.
   */
  diff(spacePath: string, versionId: number, against: DiffTarget = 'current'): Observable<VersionDiff> {
    return this.http.get<VersionDiff>(`${API_VERSIONS_DIFF}/${versionId}/${encodeUrl(spacePath)}`, {
      params: { against: String(against) }
    })
  }

  /**
   * Two answers latch `unavailable`, and they mean different things:
   *
   * - a **404** carrying `VERSIONS_DISABLED_MESSAGE` — the feature is off on this
   *   server, so no file has history. Matched on the message because these routes
   *   also 404 with 'Space not found' when SpaceGuard cannot resolve the path,
   *   and that one is per-file.
   * - a **403** — the whole VersioningController is gated on the USER role
   *   (#492), so a guest or link principal is refused every version route before
   *   any path is resolved. No message check: unlike the 404 there is no
   *   per-file 403 to confuse it with. `SpaceGuard` answers 404 for a path it
   *   cannot resolve, and the only in-feature 403 is the MODIFY refusal on
   *   restore/label/delete — which never reaches here, because those three do not
   *   report availability.
   *
   * Both are per-principal and session-long, which is what makes latching right:
   * without this, `probe()` never settles and re-fires on every file selection
   * (`file-detail.component.ts`) and every editor open — hundreds of refused
   * requests, each writing a role-guard warning server-side.
   */
  private noteAvailability(e: unknown): void {
    if (!(e instanceof HttpErrorResponse)) return
    if (e.status === 403 || (e.status === 404 && e.error?.message === VERSIONS_DISABLED_MESSAGE)) {
      this.availability.set('unavailable')
    }
  }
}
