import { Injectable, signal } from '@angular/core'
import type { DockTabId } from './dock-rail.component'

const MOBILE_BREAKPOINT = 768

@Injectable({ providedIn: 'root' })
export class LayoutV2Service {
  readonly isMobile = signal(typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT)
  readonly leftNavOpen = signal(false)
  readonly dockActive = signal<DockTabId | null>(null)
  // Desktop-only collapsed-rail state. Session-only — default expanded on
  // every fresh load. Mobile uses leftNavOpen (drawer) and ignores these.
  readonly sidebarCollapsed = signal(false)
  // True while the collapsed rail user has temporarily expanded the full
  // sidebar over content (modal-style with backdrop). Only meaningful while
  // sidebarCollapsed is true.
  readonly sidebarOverlay = signal(false)

  // Pre-auto-collapse state saved while the user is in an office/diagram
  // editor. Restored on leave so manual collapse/expand during edit doesn't
  // overwrite the user's preference.
  private autoCollapseSavedState: boolean | null = null

  constructor() {
    if (typeof document === 'undefined') return
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (this.isMobile()) {
        if (this.leftNavOpen()) {
          this.closeLeftNav()
          e.preventDefault()
          return
        }
        if (this.dockActive() !== null) {
          this.setDock(null)
          e.preventDefault()
        }
        return
      }
      if (this.sidebarOverlay()) {
        this.closeSidebarOverlay()
        e.preventDefault()
      }
    })
  }

  syncViewport(width: number): void {
    const next = width < MOBILE_BREAKPOINT
    if (next !== this.isMobile()) {
      this.isMobile.set(next)
      this.leftNavOpen.set(false)
      this.dockActive.set(null)
      this.sidebarCollapsed.set(false)
      this.sidebarOverlay.set(false)
      this.autoCollapseSavedState = null
    }
  }

  toggleLeftNav(): void {
    const next = !this.leftNavOpen()
    this.leftNavOpen.set(next)
    if (next) this.dockActive.set(null)
  }

  closeLeftNav(): void {
    this.leftNavOpen.set(false)
  }

  setDock(id: DockTabId | null): void {
    this.dockActive.set(id)
    if (id !== null) this.leftNavOpen.set(false)
  }

  toggleSidebar(): void {
    if (this.isMobile()) return
    const next = !this.sidebarCollapsed()
    this.sidebarCollapsed.set(next)
    this.sidebarOverlay.set(false)
  }

  openSidebarOverlay(): void {
    if (this.isMobile() || !this.sidebarCollapsed()) return
    this.sidebarOverlay.set(true)
  }

  closeSidebarOverlay(): void {
    this.sidebarOverlay.set(false)
  }

  // Called by the file-detail editor surfaces (office, diagrams) on enter.
  // Saves the user's current collapse state, then forces collapsed.
  // Idempotent: if already inside an auto-collapse, do nothing — so opening
  // a second office doc back-to-back keeps the original pre-editor state.
  beginAutoCollapse(): void {
    if (this.isMobile()) return
    if (this.autoCollapseSavedState !== null) return
    this.autoCollapseSavedState = this.sidebarCollapsed()
    this.sidebarCollapsed.set(true)
    this.sidebarOverlay.set(false)
  }

  // Called by the editor surfaces on leave (and on component destroy).
  // Restores the saved pre-editor state if any. Idempotent.
  endAutoCollapse(): void {
    if (this.autoCollapseSavedState === null) return
    const restore = this.autoCollapseSavedState
    this.autoCollapseSavedState = null
    if (this.isMobile()) return
    this.sidebarCollapsed.set(restore)
    this.sidebarOverlay.set(false)
  }
}
