import { HttpClient } from '@angular/common/http'
import { inject, Injectable, signal } from '@angular/core'
import { API_FILES_FAVORITES } from '@sync-in-server/backend/src/applications/files/constants/routes'
import type { DeleteFileFavoriteDto, FileFavoriteDto } from '@sync-in-server/backend/src/applications/files/dto/file-favorite.dto'
import type { FileFavorite, FileFavoriteIdentity } from '@sync-in-server/backend/src/applications/files/schemas/file-favorite.interface'
import { encodeUrl } from '@sync-in-server/backend/src/common/shared'

// Any browse row (or inspector selection) whose star this service can report on.
export interface FavoritableFile {
  id: number
  isFavorite?: boolean
}

// custom-v2-owned favorites state, on top of UPSTREAM's favorites backend
// (upstream shipped the feature in 2.5.0, commit d3724ec5; the fork's own table,
// module and endpoints are gone — see
// docs/plans/2026-09-07-favorites-upstream-adoption-plan.md).
//
// Per-row star state is AUTHORITATIVE on the browse response (`isFavorite` on each
// file), so the fork's old `GET /ids` request — one per directory opened — is gone.
// What remains here is a thin optimistic OVERRIDE layer on top of it, which has to
// be shared: two independent consumers must agree on an in-flight toggle — the file
// browser rows and the inspector panel, and the panel cannot reach the rows.
@Injectable({ providedIn: 'root' })
export class FavoritesService {
  private readonly http = inject(HttpClient)

  readonly favorites = signal<FileFavorite[]>([])

  // fileId -> desired flag, pending a fresh browse response. Empty in the common case.
  private readonly overrides = signal<ReadonlyMap<number, boolean>>(new Map())

  // browse id -> the real id upstream materialized for it.
  //
  // A file with no `files` row carries a NEGATIVE id in the browse response
  // (getProps sets `id: -stats.ino`), and adding a favorite is what materializes the
  // row. The remove endpoint is id-addressed and rejects anything below 1
  // (DeleteFileFavoriteDto's @Min(1)), so a star-then-unstar before the next browse
  // has to send the id upstream handed back, not the negative one the row still holds.
  //
  // This lives in the SERVICE rather than being pushed onto callers: the inspector
  // panel has no access to the browser's rows and so cannot adopt an id at all, and
  // an unfixable caller is exactly how the DELETE-rejection bug survived review.
  private readonly resolvedIds = new Map<number, number>()

  // The star for one row: an in-flight toggle wins, otherwise the browse response.
  isFavorite(file: FavoritableFile | null | undefined): boolean {
    if (!file) return false
    return this.overrides().get(file.id) ?? !!file.isFavorite
  }

  // Optimistically flip, fire, and roll back on failure. `onIdResolved` is how the
  // caller learns that an unmaterialized file just acquired a real id.
  toggle(spacePath: string, file: FavoritableFile): void {
    const id = file.id
    const next = !this.isFavorite(file)
    this.setOverride(id, next)
    if (next) {
      this.addFavorite(
        spacePath,
        id,
        (realFileId) => {
          // Re-assert unconditionally: a browse response landing while this POST was
          // in flight clears every override, and the row it brought back may still
          // carry the pre-toggle `isFavorite`.
          this.setOverride(id, true)
          if (realFileId === id) return
          // Hold the flag under BOTH ids — the row keeps the negative one until the
          // next browse, and carries the real one after it — and remember the mapping
          // so a remove before that browse addresses the right row.
          this.resolvedIds.set(id, realFileId)
          this.setOverride(realFileId, true)
        },
        () => this.clearOverride(id)
      )
    } else {
      this.removeFavorite(this.resolvedIds.get(id) ?? id, () => this.clearOverride(id))
    }
  }

  // Remove by id alone, for the Favorites SCREEN. Upstream's DELETE is id-addressed,
  // so this works even for a row whose location no longer resolves (isDisabled) and
  // which therefore has no addressable path to toggle through.
  removeById(fileId: number): void {
    this.removeFavorite(fileId, () => undefined)
  }

  // Called once a browse response has landed: its rows are authoritative, so every
  // override is now either confirmed or superseded.
  clearOverrides(): void {
    // Rows now carry real ids and the server's own flag, so both caches are stale.
    this.resolvedIds.clear()
    if (this.overrides().size > 0) this.overrides.set(new Map())
  }

  private setOverride(fileId: number, isFavorite: boolean): void {
    const next = new Map(this.overrides())
    next.set(fileId, isFavorite)
    this.overrides.set(next)
  }

  private clearOverride(fileId: number): void {
    const next = new Map(this.overrides())
    next.delete(fileId)
    this.overrides.set(next)
  }

  // Upstream's endpoint takes no `limit`; it returns the user's whole list. The
  // fork's old default was 100 (max 1000). Favorites lists are small by nature, so
  // this is accepted rather than paginated client-side.
  loadFavorites(): void {
    this.http.get<FileFavorite[]>(API_FILES_FAVORITES).subscribe({
      next: (favs) => this.favorites.set(favs),
      error: (e) => console.error(e)
    })
  }

  // `spacePath` is a Sync-in repository path (e.g. `files/<alias>/dir/name`) — its
  // slashes are path separators that must reach the wildcard route intact.
  // encodeUrl() percent-encodes each segment but preserves the slashes, so names
  // containing reserved chars (#, %, ?) survive the round-trip.
  //
  // `fileId` may be NEGATIVE: the browse response gives an unmaterialized file a
  // negative id, and upstream's POST materializes the row and returns the real one
  // in `{ fileId }`. The caller MUST adopt that id (see `onResolved`) — a later
  // DELETE is rejected by DeleteFileFavoriteDto's @Min(1) otherwise. This mirrors
  // classic's `if (file.id < 0) file.id = fileId` in files.service.ts.
  private addFavorite(spacePath: string, fileId: number, onResolved: (realFileId: number) => void, onError: () => void): void {
    const body: FileFavoriteDto = { fileId }
    this.http.post<FileFavoriteIdentity>(`${API_FILES_FAVORITES}/${encodeUrl(spacePath)}`, body).subscribe({
      next: ({ fileId: realFileId }) => {
        if (realFileId) onResolved(realFileId)
        this.refreshIfLoaded()
      },
      error: (e) => {
        onError()
        console.error(e)
      }
    })
  }

  // Upstream's DELETE is id-addressed and carries its id in the BODY, so it must go
  // through http.request — Angular's http.delete() cannot send one.
  private removeFavorite(fileId: number, onError: () => void): void {
    const body: DeleteFileFavoriteDto = { fileId }
    this.http.request<void>('delete', API_FILES_FAVORITES, { body }).subscribe({
      next: () => this.refreshIfLoaded(),
      error: (e) => {
        onError()
        console.error(e)
      }
    })
  }

  // Keep the Favorites screen list coherent after a successful toggle, but only
  // when it is already populated (i.e. the screen has been visited) — avoids an
  // extra request on every file-browser toggle.
  private refreshIfLoaded(): void {
    if (this.favorites().length > 0) this.loadFavorites()
  }

  // Optimistically drop a row from the screen's list so a removal is visible before
  // the refetch lands. Safe on failure: refreshIfLoaded re-reads the server's truth.
  dropFromList(fileId: number): void {
    this.favorites.update((favs) => favs.filter((f) => f.fileId !== fileId))
  }
}
