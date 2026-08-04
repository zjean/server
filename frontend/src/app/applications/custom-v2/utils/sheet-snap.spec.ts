// Where a dragged bottom sheet lands.
//
// The gesture itself can only be verified on a real device — this harness has no
// pointer, and agent-browser's Chromium fires no rAF — so what is pinned here is the
// arithmetic that decides the outcome, which is the part that can be wrong silently: a
// dismissal threshold that is too small makes the sheet impossible to keep open, and one
// that is too large makes it impossible to close.

import { describe, expect, it } from 'vitest'
import { resolveSheetDrag, sheetDragHeight, SHEET_SNAP_PERCENT } from './sheet-snap'

const VH = 800

describe('resolveSheetDrag', () => {
  it('uses the design’s two heights', () => {
    expect(SHEET_SNAP_PERCENT).toEqual({ half: 50, full: 92 })
  })

  it('keeps a short drag where it started', () => {
    // 10% of the viewport down from half — nearer 50 than 0.
    expect(resolveSheetDrag({ from: 'half', deltaPx: 80, viewportPx: VH })).toBe('half')
  })

  it('dismisses a drag that passes a quarter of the viewport below half', () => {
    expect(resolveSheetDrag({ from: 'half', deltaPx: 0.24 * VH, viewportPx: VH })).toBe('half')
    expect(resolveSheetDrag({ from: 'half', deltaPx: 0.26 * VH, viewportPx: VH })).toBe('dismiss')
  })

  it('drops full to half rather than dismissing it, when dragged past their midpoint', () => {
    // The midpoint of 92 and 50 is 71, so the two cases sit either side of it.
    expect(resolveSheetDrag({ from: 'full', deltaPx: 0.2 * VH, viewportPx: VH })).toBe('full')
    expect(resolveSheetDrag({ from: 'full', deltaPx: 0.23 * VH, viewportPx: VH })).toBe('half')
  })

  it('grows half to full when dragged up past the midpoint', () => {
    expect(resolveSheetDrag({ from: 'half', deltaPx: -0.2 * VH, viewportPx: VH })).toBe('half')
    expect(resolveSheetDrag({ from: 'half', deltaPx: -0.25 * VH, viewportPx: VH })).toBe('full')
  })

  describe('a flick', () => {
    it('goes up to full from either height, however short', () => {
      expect(resolveSheetDrag({ from: 'half', deltaPx: -4, viewportPx: VH, velocityPxPerMs: -1.2 })).toBe('full')
      expect(resolveSheetDrag({ from: 'full', deltaPx: -4, viewportPx: VH, velocityPxPerMs: -1.2 })).toBe('full')
    })

    it('takes full down to half, not to dismissal', () => {
      // One step per gesture: the tallest state must not be the easiest to lose.
      expect(resolveSheetDrag({ from: 'full', deltaPx: 6, viewportPx: VH, velocityPxPerMs: 1.4 })).toBe('half')
    })

    it('dismisses from half', () => {
      expect(resolveSheetDrag({ from: 'half', deltaPx: 6, viewportPx: VH, velocityPxPerMs: 1.4 })).toBe('dismiss')
    })

    it('is not a flick below the threshold — geometry decides instead', () => {
      // Same tiny downward movement, slow: it stays put.
      expect(resolveSheetDrag({ from: 'half', deltaPx: 6, viewportPx: VH, velocityPxPerMs: 0.2 })).toBe('half')
    })
  })

  it('leaves the sheet alone when the viewport cannot be measured', () => {
    expect(resolveSheetDrag({ from: 'full', deltaPx: 300, viewportPx: 0 })).toBe('full')
  })
})

describe('sheetDragHeight', () => {
  it('tracks the finger downward', () => {
    expect(sheetDragHeight({ from: 'half', deltaPx: 100, viewportPx: VH })).toBe(300)
  })

  it('tracks the finger upward', () => {
    expect(sheetDragHeight({ from: 'half', deltaPx: -100, viewportPx: VH })).toBe(500)
  })

  it('never paints taller than the tallest snap', () => {
    // Dragging up past `full` would otherwise stretch the sheet over the whole viewport
    // and spring back on release, which reads as a bug rather than a limit.
    expect(sheetDragHeight({ from: 'full', deltaPx: -VH, viewportPx: VH })).toBe(0.92 * VH)
  })

  it('never paints a negative height', () => {
    expect(sheetDragHeight({ from: 'half', deltaPx: 5 * VH, viewportPx: VH })).toBe(0)
  })
})
