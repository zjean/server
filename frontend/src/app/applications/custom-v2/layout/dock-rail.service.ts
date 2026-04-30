import { Injectable, signal } from '@angular/core'
import { IconV2Name } from '../icons/icon-v2.component'

export type DockTabId = string

export interface DockTab {
  id: DockTabId
  icon: IconV2Name
  label: string
}

// Minimal context for the dock panel's file-scoped tabs (Info / Comments /
// Tree). Screens that browse files write this signal when their selection
// is exactly one row, and clear it otherwise. Path is the backend-relative
// shape consumed by /api/comments/spaces/{path} — same convention as
// FileDetailComponent.currentPath.
export interface DockSelectedFile {
  id: number
  name: string
  path: string
  mime: string
  size: number
  isDir: boolean
  mtime?: number
  ctime?: number
}

// Mirrors classic's right-rail model (sidebar.right.component.ts): screens
// register their own tab set on mount and clear it on destroy. The rail
// hides when no screen is registering anything (e.g. /search, /settings) so
// we don't surface dead "Coming soon." buttons in contexts that have no use
// for them.
@Injectable({ providedIn: 'root' })
export class DockRailService {
  readonly tabs = signal<DockTab[]>([])
  // Single-row selection from the active file-list screen. Drives the
  // dock panel body: when null, panels render an empty state ("Select a
  // file to see details") instead of breaking.
  readonly currentSelected = signal<DockSelectedFile | null>(null)

  setTabs(tabs: DockTab[]): void {
    this.tabs.set(tabs)
  }

  clear(): void {
    this.tabs.set([])
    this.currentSelected.set(null)
  }
}

// Standard tab set for any screen that browses files with selection.
// Matches classic's SpacesNavComponent registration: Info / Tree / Comments
// (clipboard would only appear when populated — defer until clipboard wires up).
export const FILE_BROWSER_DOCK_TABS: DockTab[] = [
  { id: 'info', icon: 'info', label: 'Info' },
  { id: 'tree', icon: 'shareTree', label: 'Tree' },
  { id: 'comment', icon: 'comment', label: 'Comments' }
]
