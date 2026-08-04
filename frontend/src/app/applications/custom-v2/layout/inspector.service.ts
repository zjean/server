import { Injectable, signal } from '@angular/core'
import { Subject } from 'rxjs'

// The four tabs the inspector always shows, in the design's own order
// (D4/D5: `Properties · Comments 4 · Versions 3 · Activity`). Fixed rather than
// registered per screen: the strip is labelled and evenly divided, so a screen
// that contributed only two tabs would render two half-width words and read as a
// different control. A tab with nothing to show renders its own empty state.
export const INSPECTOR_TABS = ['properties', 'comments', 'versions', 'activity'] as const
export type InspectorTabId = (typeof INSPECTOR_TABS)[number]

// Minimal context for the inspector's file-scoped tabs. Screens that browse
// files write this signal when their selection is exactly one row, and clear it
// otherwise. Path is the backend-relative shape consumed by
// /api/comments/spaces/{path} — same convention as FileDetailComponent.currentPath.
export interface InspectorFile {
  id: number
  name: string
  path: string
  mime: string
  size: number
  isDir: boolean
  mtime?: number
  ctime?: number
  // Both come from the same browse response the row does, and both are optional
  // because not every producer has them: the ACCESS band renders only what it
  // was given rather than asking a second endpoint per selection.
  shares?: { id: number; name?: string; alias?: string; type?: number }[]
  hasComments?: boolean
}

// Which screens have an inspector, and what it is currently pointed at.
//
// This replaces the icon rail that used to live to the right of the content
// (`dock-rail.component`). The rail was option `2c` in the design's own
// exploration and was rejected there: "it reintroduces unlabelled icons — only
// viable with permanent tooltips". Its two jobs are split in two:
//
//   • `available` — whether this screen has an inspector at all, which is what
//     decides if the top bar offers the toggle. Screens with no single-row
//     selection model (search, settings, trash, the shares lists) leave it false
//     so ⌘I and the toggle stay inert rather than opening an empty panel.
//   • `currentSelected` — the file the panel describes.
@Injectable({ providedIn: 'root' })
export class InspectorService {
  readonly available = signal(false)
  readonly currentSelected = signal<InspectorFile | null>(null)

  /**
   * Fires when the panel has replaced the selected file's CONTENT — today only a
   * version restore does this.
   *
   * The host has to know, and cannot work it out: a restore rewrites the live
   * bytes, so the size, the mtime and whatever is rendering the file are all
   * stale. It used to be an output on the versions panel wired straight into
   * file-detail; now that the same panel is reachable from the file browsers, the
   * signal has to reach whichever screen is mounted, and only the screen knows how
   * to refresh itself.
   */
  readonly contentReplaced = new Subject<void>()

  setAvailable(available: boolean): void {
    this.available.set(available)
  }

  clear(): void {
    this.available.set(false)
    this.currentSelected.set(null)
  }
}
