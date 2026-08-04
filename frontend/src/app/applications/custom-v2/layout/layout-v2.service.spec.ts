// Pins the inspector half of LayoutV2Service — the part of it that is persisted
// state rather than a signal flipped by one component.
//
// These exist because the design states them as requirements and none of
// them fails visibly when wrong: a width that does not clamp lets a drag collapse
// the panel to nothing, a tab that does not persist forgets which tab you were on
// at every file, and an overlay breakpoint that includes mobile would put a
// desktop scrim over the bottom tab bar.
//
// No TestBed: the service takes one dependency (InspectorService) and reads
// localStorage directly, so a plain Injector is enough. Same shape as
// file-browser-harness.ts, for the same reason.

import { Injector, runInInjectionContext } from '@angular/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { InspectorService } from './inspector.service'
import { clampDockWidth, DOCK_WIDTH_DEFAULT, DOCK_WIDTH_MAX, DOCK_WIDTH_MIN, LayoutV2Service } from './layout-v2.service'

const store = new Map<string, string>()

// jsdom is not in this suite's environment (`environment: node`), so window and
// localStorage are stubbed to exactly what the service touches. The service also
// guards on `typeof document === 'undefined'` for its keydown listener, which
// stays undefined here — the shortcut is browser-verified rather than unit-tested.
function stubBrowser(width = 1440): void {
  ;(globalThis as unknown as { window: unknown }).window = {
    innerWidth: width,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k)
    }
  }
}

// The inspector is handed back too, because half of what this service decides
// depends on whether the mounted screen has one.
function build(width = 1440): { svc: LayoutV2Service; inspector: InspectorService } {
  stubBrowser(width)
  const inspector = new InspectorService()
  const injector = Injector.create({ providers: [{ provide: InspectorService, useValue: inspector }] })
  return { svc: runInInjectionContext(injector, () => new LayoutV2Service()), inspector }
}

describe('LayoutV2Service — the inspector', () => {
  beforeEach(() => store.clear())

  describe('width', () => {
    it('defaults to the design’s 340px', () => {
      expect(build().svc.dockWidth()).toBe(DOCK_WIDTH_DEFAULT)
      expect(DOCK_WIDTH_DEFAULT).toBe(340)
    })

    it('clamps to 300–520, which is the design’s stated range', () => {
      expect(clampDockWidth(10)).toBe(DOCK_WIDTH_MIN)
      expect(clampDockWidth(9999)).toBe(DOCK_WIDTH_MAX)
      expect(clampDockWidth(401.6)).toBe(402)
    })

    it('persists a set width and reads it back on the next session', () => {
      build().svc.setDockWidth(480)
      expect(build().svc.dockWidth()).toBe(480)
    })

    // The frames of a drag must move the panel without writing localStorage a few
    // hundred times, so `persist: false` updates the signal only.
    it('does not persist a preview width', () => {
      const { svc } = build()
      svc.setDockWidth(500)
      svc.setDockWidth(310, false)
      expect(svc.dockWidth()).toBe(310)
      expect(build().svc.dockWidth()).toBe(500)
    })

    it('falls back to the default for a stored value that is not a number', () => {
      store.set('ui.inspector.width', 'wide')
      expect(build().svc.dockWidth()).toBe(DOCK_WIDTH_DEFAULT)
    })

    // A stored width from a session with a wider range must not survive as-is:
    // reading is where the clamp has to happen too, not just writing.
    it('clamps a stored value that is out of range', () => {
      store.set('ui.inspector.width', '900')
      expect(build().svc.dockWidth()).toBe(DOCK_WIDTH_MAX)
    })
  })

  describe('tab', () => {
    it('defaults to properties and persists a selection', () => {
      expect(build().svc.dockTab()).toBe('properties')
      build().svc.setDockTab('versions')
      expect(build().svc.dockTab()).toBe('versions')
    })

    // The two spellings the file-detail aside used before the panels were unified
    // ('info', 'comment') are not tab ids any more, so a value left in storage by
    // an older build must not select a tab that does not exist.
    it('falls back to properties for an unrecognised stored tab', () => {
      store.set('ui.inspector.tab', 'info')
      expect(build().svc.dockTab()).toBe('properties')
    })
  })

  describe('breakpoints', () => {
    it('docks at 1180px and above, overlays below it', () => {
      expect(build(1440).svc.dockOverlay()).toBe(false)
      expect(build(1180).svc.dockOverlay()).toBe(false)
      expect(build(1179).svc.dockOverlay()).toBe(true)
    })

    // Mobile is a right-anchored sheet handled in CSS, not the desktop overlay —
    // its scrim stops above the bottom tab bar, and the desktop one does not.
    it('never reports overlay on mobile, which has its own sheet', () => {
      const { svc } = build(390)
      expect(svc.isMobile()).toBe(true)
      expect(svc.dockOverlay()).toBe(false)
    })

    it('closes the panel when the viewport crosses the mobile boundary', () => {
      const { svc } = build(1440)
      svc.openDock()
      svc.syncViewport(500)
      expect(svc.dockOpen()).toBe(false)
    })

    // ...but NOT on every resize: a drag of the window edge that stays on one side
    // of the boundary must leave the panel alone.
    it('leaves the panel open when the resize stays on one side of it', () => {
      const { svc } = build(1440)
      svc.openDock()
      svc.syncViewport(1200)
      expect(svc.dockOpen()).toBe(true)
    })
  })

  describe('open state', () => {
    it('toggles, and closing the panel is not the same as clearing the tab', () => {
      const { svc } = build()
      svc.setDockTab('comments')
      svc.toggleDock()
      expect(svc.dockOpen()).toBe(true)
      svc.toggleDock()
      expect(svc.dockOpen()).toBe(false)
      expect(svc.dockTab()).toBe('comments')
    })

    // `dockOpen` is intent and survives navigation; `dockVisible` is what renders.
    // Conflating them left an empty panel open on /shared and /trash, which
    // register no selection — and closing it there would have cost the user a
    // second ⌘I on the way back.
    it('renders only on a screen that has an inspector, without forgetting the intent', () => {
      const { svc, inspector } = build()
      inspector.setAvailable(true)
      svc.openDock()
      expect(svc.dockVisible()).toBe(true)
      inspector.clear()
      expect(svc.dockVisible()).toBe(false)
      expect(svc.dockOpen()).toBe(true)
      inspector.setAvailable(true)
      expect(svc.dockVisible()).toBe(true)
    })

    // Both are overlays on mobile and they anchor to opposite edges; open together
    // they would each be half-covered by the other's scrim.
    it('closes the left nav when the panel opens', () => {
      const { svc } = build(390)
      svc.toggleLeftNav()
      expect(svc.leftNavOpen()).toBe(true)
      svc.openDock()
      expect(svc.leftNavOpen()).toBe(false)
    })
  })
})
