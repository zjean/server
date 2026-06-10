import { HttpClient } from '@angular/common/http'
import { inject, Injectable, signal } from '@angular/core'
import { API_CUSTOM_FAVORITES } from '@sync-in-server/backend/src/applications/custom-favorites/constants/routes'
import type { FileFavorite } from '@sync-in-server/backend/src/applications/custom-favorites/interfaces/file-favorite.interface'

// custom-v2-owned favorites state. Deliberately self-contained — it does NOT
// touch the upstream StoreService or FilesService, so an upstream sync never
// has to reckon with fork-only favorite state. Two signals back the two views:
//   - `favorites`     → the Favorites screen list (full FileFavorite rows)
//   - `favoriteIds`   → a Set used by the file browser to render the star
//                       indicator + drive the context-menu label cheaply.
@Injectable({ providedIn: 'root' })
export class FavoritesService {
  private readonly http = inject(HttpClient)

  readonly favorites = signal<FileFavorite[]>([])
  readonly favoriteIds = signal<Set<number>>(new Set())

  loadFavorites(limit = 100): void {
    this.http.get<FileFavorite[]>(API_CUSTOM_FAVORITES, { params: { limit } }).subscribe({
      next: (favs) => this.favorites.set(favs),
      error: (e) => console.error(e)
    })
  }

  loadFavoriteIds(): void {
    this.http.get<number[]>(`${API_CUSTOM_FAVORITES}/ids`).subscribe({
      next: (ids) => this.favoriteIds.set(new Set(ids)),
      error: (e) => console.error(e)
    })
  }

  isFavorite(fileId: number): boolean {
    return this.favoriteIds().has(fileId)
  }

  // Optimistically flip the Set so the star/menu update instantly, then fire
  // the path-based add/remove. On error the Set rolls back to its prior state.
  // `spacePath` is a Sync-in repository path (e.g. `files/<alias>/dir/name`) —
  // its slashes are path separators that must reach the wildcard route intact,
  // so we append it raw (mirrors how space-files builds the browse URL with a
  // plain join rather than encodeURIComponent).
  toggle(spacePath: string, fileId: number, add: boolean): void {
    const previous = this.favoriteIds()
    const next = new Set(previous)
    if (add) next.add(fileId)
    else next.delete(fileId)
    this.favoriteIds.set(next)

    const url = `${API_CUSTOM_FAVORITES}/spaces/${spacePath}`
    const request = add ? this.http.post<FileFavorite>(url, {}) : this.http.delete<void>(url)
    request.subscribe({
      next: () => {
        // Keep the Favorites screen list coherent after a successful toggle.
        // Only refresh when the list is already populated (i.e. the screen has
        // been visited) — avoids an extra request on every browser toggle.
        if (this.favorites().length > 0) this.loadFavorites()
      },
      error: (e) => {
        this.favoriteIds.set(previous)
        console.error(e)
      }
    })
  }
}
