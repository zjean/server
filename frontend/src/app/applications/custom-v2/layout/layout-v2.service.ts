import { computed, inject, Injectable, signal } from '@angular/core'
import { SheetSnap } from '../utils/sheet-snap'
import { INSPECTOR_TABS, InspectorService, InspectorTabId } from './inspector.service'

const MOBILE_BREAKPOINT = 768
// The design's own figure: "Panel 340px — surface-0.5, docked; becomes an
// overlay under 1180px" (Patterns §01), restated in the shared rules for the
// panel explorations. It is the width at which a 340px panel plus a 248px nav
// stops leaving the content plane its 640px minimum.
const DOCK_OVERLAY_BREAKPOINT = 1180
// The same figure from the other side: below 1180 the design's navigation is "icon
// rail 64px with tooltips; ⌘B expands as overlay". One constant, because the two rules
// are one decision — at that width there is not room for a 248px sidebar AND a 640px
// content plane AND a panel.
const RAIL_BREAKPOINT = 1180

export const DOCK_WIDTH_MIN = 300
export const DOCK_WIDTH_MAX = 520
export const DOCK_WIDTH_DEFAULT = 340

const DOCK_TAB_KEY = 'ui.inspector.tab'
const DOCK_WIDTH_KEY = 'ui.inspector.width'

const hasStorage = (): boolean => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'

/**
 * Whether a bare-key shortcut should be ignored because the user is writing.
 *
 * `isContentEditable` matters as much as the two element types: the markdown editor and the
 * comment composer are both contenteditable, and a `?` swallowed there would be a character
 * the user typed and did not get.
 */
function isTypingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable
}

function readStoredTab(): InspectorTabId {
  if (!hasStorage()) return 'properties'
  const raw = window.localStorage.getItem(DOCK_TAB_KEY) ?? ''
  return (INSPECTOR_TABS as readonly string[]).includes(raw) ? (raw as InspectorTabId) : 'properties'
}

function readStoredWidth(): number {
  if (!hasStorage()) return DOCK_WIDTH_DEFAULT
  const n = Number(window.localStorage.getItem(DOCK_WIDTH_KEY))
  return Number.isFinite(n) && n > 0 ? clampDockWidth(n) : DOCK_WIDTH_DEFAULT
}

export function clampDockWidth(px: number): number {
  return Math.min(DOCK_WIDTH_MAX, Math.max(DOCK_WIDTH_MIN, Math.round(px)))
}

@Injectable({ providedIn: 'root' })
export class LayoutV2Service {
  // Declared first because `dockVisible` below reads it. A computed would in fact
  // tolerate the reverse order (it dereferences lazily), but this file is read by
  // people who have been bitten by field-initialisation order elsewhere in v2.
  private readonly inspector = inject(InspectorService)

  // One source of truth for the viewport, because two breakpoints now read it.
  // `isMobile` was a signal set by `syncViewport`; it is derived now so a second
  // breakpoint cannot drift out of step with the first.
  readonly viewportWidth = signal(typeof window !== 'undefined' ? window.innerWidth : 1440)
  readonly isMobile = computed(() => this.viewportWidth() < MOBILE_BREAKPOINT)
  readonly leftNavOpen = signal(false)

  // The inspector. Open-ness is session state; which tab and how wide are the
  // user's, and both persist — "tab selection persists across files. Width is
  // drag-resizable 300–520px and remembered per user" (the design's shared rules
  // for the panel).
  readonly dockOpen = signal(false)
  readonly dockTab = signal<InspectorTabId>(readStoredTab())
  readonly dockWidth = signal(readStoredWidth())
  // Below 1180px the docked panel (option `2a`) becomes the overlay (`2b`): it
  // floats over the content on a scrim instead of narrowing it. Mobile is a third
  // case handled in CSS (a right-anchored sheet), so this is desktop-only.
  readonly dockOverlay = computed(() => !this.isMobile() && this.viewportWidth() < DOCK_OVERLAY_BREAKPOINT)

  /**
   * Which of the two heights the mobile inspector sheet is resting at (`M3`).
   *
   * Session state, and reset to `half` on every close rather than remembered: the sheet
   * opens over whatever the user was just reading, and a sheet that opens at 92% because
   * of a gesture three files ago covers the file it is describing.
   */
  readonly sheetSnap = signal<SheetSnap>('half')

  /** The `?` shortcut sheet. Session state; nothing about it is worth persisting. */
  readonly shortcutsOpen = signal(false)

  /**
   * The sidebar is a rail because the viewport says so, not because the user asked.
   *
   * Kept separate from `sidebarCollapsed` — which is the user's own preference and the
   * editors' auto-collapse — so that widening the window restores whatever the user had
   * rather than whatever the last breakpoint forced.
   */
  readonly railForced = computed(() => !this.isMobile() && this.viewportWidth() < RAIL_BREAKPOINT)

  /** What the nav actually renders as: forced by width, or chosen by the user. */
  readonly sidebarIsRail = computed(() => this.railForced() || this.sidebarCollapsed())
  // Open AND on a screen that has an inspector. The two are separate because
  // `dockOpen` is the user's standing intent and survives navigation: leaving a
  // file browser for /shared must hide the panel, and coming back must bring it
  // back without a second ⌘I. Rendering on `dockOpen` alone left an empty panel
  // sitting open on every screen that has no selection model.
  readonly dockVisible = computed(() => this.dockOpen() && this.inspector.available())

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
      // ⌘I / Ctrl-I toggles the inspector. Bound on the document rather than in a
      // component so it works on every screen that has one, and preventDefault is
      // only called when we act — Firefox's "page info" is Ctrl-I and we should not
      // eat it on a screen with no inspector.
      if ((e.key === 'i' || e.key === 'I') && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        if (!this.inspector.available()) return
        this.toggleDock()
        e.preventDefault()
        return
      }
      // `?` — Shift+/ on most layouts, its own key on some, so the character is what to
      // test rather than the code. Guarded on the event target the way the file browser's
      // bare-key shortcuts are: a question mark typed into a filter is a question mark.
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingInto(e.target)) {
        this.shortcutsOpen.update((v) => !v)
        e.preventDefault()
        return
      }
      if (e.key !== 'Escape') return
      if (this.isMobile()) {
        if (this.leftNavOpen()) {
          this.closeLeftNav()
          e.preventDefault()
          return
        }
        if (this.dockOpen()) {
          this.closeDock()
          e.preventDefault()
        }
        return
      }
      // "Esc closes; click-outside closes" is a rule of the OVERLAY (`2b`) only.
      // A docked panel is part of the layout, not something dismissible.
      if (this.dockOverlay() && this.dockOpen()) {
        this.closeDock()
        e.preventDefault()
        return
      }
      if (this.sidebarOverlay()) {
        this.closeSidebarOverlay()
        e.preventDefault()
      }
    })
  }

  syncViewport(width: number): void {
    const wasMobile = this.isMobile()
    this.viewportWidth.set(width)
    if (this.isMobile() !== wasMobile) {
      this.leftNavOpen.set(false)
      this.dockOpen.set(false)
      this.sidebarCollapsed.set(false)
      this.sidebarOverlay.set(false)
      this.autoCollapseSavedState = null
    }
  }

  toggleLeftNav(): void {
    const next = !this.leftNavOpen()
    this.leftNavOpen.set(next)
    if (next) this.dockOpen.set(false)
  }

  closeLeftNav(): void {
    this.leftNavOpen.set(false)
  }

  toggleDock(): void {
    this.setDockOpen(!this.dockOpen())
  }

  openDock(): void {
    this.setDockOpen(true)
  }

  closeDock(): void {
    this.setDockOpen(false)
  }

  setDockOpen(open: boolean): void {
    this.dockOpen.set(open)
    if (open) this.leftNavOpen.set(false)
    else this.sheetSnap.set('half')
  }

  /** The handle is also a button: tapping it steps between the two heights. */
  toggleSheetSnap(): void {
    this.sheetSnap.update((s) => (s === 'half' ? 'full' : 'half'))
  }

  setDockTab(tab: InspectorTabId): void {
    this.dockTab.set(tab)
    if (hasStorage()) window.localStorage.setItem(DOCK_TAB_KEY, tab)
  }

  // `persist: false` is for the frames of a drag — the signal moves so the panel
  // tracks the pointer, but only the release writes the preference.
  setDockWidth(px: number, persist = true): void {
    const next = clampDockWidth(px)
    this.dockWidth.set(next)
    if (persist && hasStorage()) window.localStorage.setItem(DOCK_WIDTH_KEY, String(next))
  }

  toggleSidebar(): void {
    if (this.isMobile()) return
    // Below the rail breakpoint the sidebar cannot expand in place — there is no room
    // for it. ⌘B opens it over the content instead, which is what the design specifies
    // for this band and what the collapsed-rail user already gets on click.
    if (this.railForced()) {
      this.sidebarOverlay.update((v) => !v)
      return
    }
    const next = !this.sidebarCollapsed()
    this.sidebarCollapsed.set(next)
    this.sidebarOverlay.set(false)
  }

  openSidebarOverlay(): void {
    if (this.isMobile() || !this.sidebarIsRail()) return
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
