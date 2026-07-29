import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { inject, Injectable } from '@angular/core'
import { API_VERSIONS_ADMIN_PURGE, API_VERSIONS_ADMIN_STORAGE } from '@sync-in-server/backend/src/applications/custom-versioning/constants/routes'
import { VERSIONS_DISABLED_MESSAGE } from '@sync-in-server/backend/src/applications/custom-versioning/constants/versioning'
import type { PurgeVersionsRootDto } from '@sync-in-server/backend/src/applications/custom-versioning/dto/version.dto'
import type {
  VersionsPurgeResult,
  VersionsStorageSummary
} from '@sync-in-server/backend/src/applications/custom-versioning/interfaces/version.interface'
import { Observable } from 'rxjs'

/**
 * Instance-wide version storage, for the admin Tools screen.
 *
 * Separate from `VersionsService`, which addresses ONE file's history through a
 * space path and is authorized by the space guard. These two endpoints address
 * the whole store and are authorized by the ADMINISTRATOR role, so a non-admin
 * gets a 403 rather than an empty answer.
 *
 * Nothing here is polled. Version storage changes on saves, not on a server-side
 * job the operator is watching, so the panel loads once and refreshes after its
 * own purge.
 */
@Injectable({ providedIn: 'root' })
export class VersionsAdminService {
  private readonly http = inject(HttpClient)

  storage(): Observable<VersionsStorageSummary> {
    return this.http.get<VersionsStorageSummary>(API_VERSIONS_ADMIN_STORAGE)
  }

  /**
   * Deletes every UNNAMED version in one root (`user:<login>` or
   * `space:<alias>`), blobs included, and reports what went and what stayed.
   *
   * Named versions always survive — there is no flag to remove them — so a
   * non-zero `keptLabeled` is why a purged root is not empty afterwards, not a
   * failure. Confirm with the operator before calling: this is not undoable.
   */
  purge(versionsRoot: string): Observable<VersionsPurgeResult> {
    const dto: PurgeVersionsRootDto = { versionsRoot }
    return this.http.post<VersionsPurgeResult>(API_VERSIONS_ADMIN_PURGE, dto)
  }
}

/**
 * Whether a failure means `files.versions.enabled` is off on this server.
 *
 * Every versions endpoint 404s while the feature is disabled, and status alone
 * is ambiguous, so the signal is the message — matched against the backend
 * constant this file imports, which is what keeps the wording from drifting.
 * `VersionsService` applies the same rule for the per-file panel.
 */
export function isVersioningDisabledError(e: unknown): boolean {
  return e instanceof HttpErrorResponse && e.status === 404 && e.error?.message === VERSIONS_DISABLED_MESSAGE
}
