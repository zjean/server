import { Location } from '@angular/common'
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { NavigationEnd, Router } from '@angular/router'
import { filter } from 'rxjs/operators'
import { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { encodeUrl } from '@sync-in-server/backend/src/common/shared'
import { V2_PATH, V2_ROUTES } from '../v2.constants'

export interface PreviewTarget {
  path: string
  file: FileProps | null
}

// Sole owner of "is the preview overlay open and on what file?".
//
// Opening pushes a synthetic URL via Location.go (NOT router navigation) so
// the underlying route stays mounted — the v2 list screen behind the overlay
// keeps its scroll position and signals untouched, and browser back closes
// the overlay without re-running route resolvers.
//
// The URL contract is `<current-path>?preview=<encoded-path>`. The query
// param is the source of truth: deep-linking, refresh, and shareable URLs
// all reduce to "screen X with preview=Y" — no separate state to keep in
// sync. Popstate is reflected back into the signal so browser back/forward
// drive the overlay correctly.
@Injectable({ providedIn: 'root' })
export class PreviewOverlayService {
  private readonly router = inject(Router)
  private readonly location = inject(Location)
  private readonly destroyRef = inject(DestroyRef)

  readonly current = signal<PreviewTarget | null>(null)
  readonly isOpen = computed(() => this.current() !== null)

  // Optional close-guard registered by the active sub-view (e.g. text/code
  // editor) so unsaved-changes confirmation can run before the overlay
  // closes. Returns true to allow close, false to cancel.
  //
  // Limitation: only fires on close() (shell X-button + Esc). Does NOT
  // fire when the user navigates away via browser back/forward (popstate
  // is fundamentally asynchronous and uncancellable in browsers without
  // beforeunload). For browser back, the sub-view's ngOnDestroy still
  // releases the lock; unsaved content is lost. The status indicator
  // ("Modified") warns the user.
  private closeGuard: (() => Promise<boolean>) | null = null
  setCloseGuard(guard: (() => Promise<boolean>) | null): void {
    this.closeGuard = guard
  }

  constructor() {
    // Re-read the URL on every router event AND on raw popstate so the
    // overlay reflects ?preview=... whenever it changes. Router's
    // NavigationEnd covers SPA navigations; PopStateEvent covers Location.go
    // pushes that don't trigger router events.
    this.router.events
      .pipe(
        filter((e): e is NavigationEnd => e instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(() => this.syncFromUrl())
    this.location.subscribe(() => this.syncFromUrl())
    // Initial read on construction (covers refresh while overlay open).
    this.syncFromUrl()
  }

  // Open the overlay over the current route. The route doesn't change; only
  // the query string gains `?preview=<path>`. If the same path is already
  // open, this is a no-op so we don't stack history entries.
  open(path: string, file: FileProps | null = null): void {
    if (!path) return
    if (this.current()?.path === path) return
    this.current.set({ path, file })
    this.location.go(this.urlWithPreview(path))
  }

  // Close the overlay by going back if we're the top of the stack we just
  // pushed, otherwise replace the URL to drop ?preview=. We use
  // history.length-based detection conservatively — if we can't be sure
  // we own the entry, fall back to replaceState so we never strand a
  // bogus history entry.
  //
  // Async because a registered closeGuard (e.g. unsaved-changes
  // confirmation) may need to await user input before allowing close.
  async close(): Promise<void> {
    if (this.current() === null) return
    if (this.closeGuard) {
      const ok = await this.closeGuard()
      if (!ok) return
    }
    // We always pushed exactly one entry on open(), so back() restores
    // the underlying route's URL without re-running resolvers.
    if (typeof window !== 'undefined' && window.history.length > 1) {
      this.location.back()
    } else {
      this.location.replaceState(this.urlWithoutPreview())
      this.current.set(null)
    }
  }

  // Build the standalone (new-tab) URL. Used by the auxclick handler on
  // file rows so middle-click opens the chromeless route directly.
  buildStandaloneUrl(path: string): string {
    return `/#/${V2_PATH}/${V2_ROUTES.PREVIEW}?path=${encodeURIComponent(path)}`
  }

  private syncFromUrl(): void {
    const tree = this.router.parseUrl(this.router.url)
    const previewPath = tree.queryParamMap.get('preview')
    if (!previewPath) {
      if (this.current() !== null) this.current.set(null)
      return
    }
    if (this.current()?.path !== previewPath) {
      // URL says preview is open but we have no FileProps for it — that's
      // fine, the PreviewComponent loads the file by path itself.
      this.current.set({ path: previewPath, file: null })
    }
  }

  private urlWithPreview(path: string): string {
    const tree = this.router.parseUrl(this.router.url)
    tree.queryParams = { ...tree.queryParams, preview: path }
    return tree.toString()
  }

  private urlWithoutPreview(): string {
    const tree = this.router.parseUrl(this.router.url)
    const { preview: _drop, ...rest } = tree.queryParams
    tree.queryParams = rest
    return tree.toString()
  }
}

// Path-segment encoder used for the file-content URL (multi-segment, slashes
// preserved). Re-exported here so callers in this folder don't have to know
// about the backend shared module.
export { encodeUrl }
