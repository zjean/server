import { Injectable, signal } from '@angular/core'
import type { DockTabId } from './dock-rail.component'

const MOBILE_BREAKPOINT = 768

@Injectable({ providedIn: 'root' })
export class LayoutV2Service {
  readonly isMobile = signal(typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT)
  readonly leftNavOpen = signal(false)
  readonly dockActive = signal<DockTabId | null>(null)

  constructor() {
    if (typeof document === 'undefined') return
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (!this.isMobile()) return
      if (this.leftNavOpen()) {
        this.closeLeftNav()
        e.preventDefault()
        return
      }
      if (this.dockActive() !== null) {
        this.setDock(null)
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
}
