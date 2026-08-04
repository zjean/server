/** The two heights a bottom sheet rests at, as a percentage of the viewport. */
export type SheetSnap = 'half' | 'full'

/**
 * The design's own figures: "Sheets snap to 50% and 92% height" (Mobile Screens,
 * *What moves to a sheet*). 92 rather than 100 is what leaves the scrim visible above
 * the sheet, which is the only affordance saying the thing underneath is still there.
 */
export const SHEET_SNAP_PERCENT: Record<SheetSnap, number> = { half: 50, full: 92 }

/** Dismissal is modelled as a third snap point at zero height. */
const DISMISS_PERCENT = 0

/**
 * A flick beats geometry. Below this the gesture is read as a drag and resolved by
 * where it ended; above it, by which way it was going. 0.6 px/ms ≈ 600 px/s, which is
 * about a third of a comfortable thumb flick on a 390px screen and well clear of the
 * speed a slow drag reaches.
 */
const FLICK_PX_PER_MS = 0.6

export interface SheetDragEnd {
  /** Where the sheet was resting when the gesture began. */
  from: SheetSnap
  /** Distance travelled, positive DOWNWARD (the direction that shrinks the sheet). */
  deltaPx: number
  /** Viewport height the percentages are relative to. */
  viewportPx: number
  /** Signed, positive downward. Omit when the gesture was too short to measure. */
  velocityPxPerMs?: number
}

/**
 * Where a bottom sheet lands when the finger lifts.
 *
 * Pure, and separate from the directive that wires it to pointer events, because this
 * is the half with the decisions in it and the half a test can reach: the harness has
 * no pointer, and `agent-browser`'s Chromium fires no `requestAnimationFrame`, so a
 * gesture is verified on a real device and the *rules* are verified here.
 *
 * The rules, in order:
 *
 *  • **A flick goes where it was thrown**, one step per gesture: down from `full` is
 *    `half`, down from `half` is dismissal, up is always `full`. One step matters —
 *    a fast flick down from `full` that dismissed outright would make the sheet's
 *    tallest state the easiest one to lose.
 *  • **Otherwise the nearest resting height wins**, dismissal included, measured from
 *    where the drag actually ended. That puts the dismissal threshold at 25% of the
 *    viewport below `half` without naming a second constant for it: 50 → 20 is nearer
 *    to 0 than to 50, 50 → 30 is not.
 */
export function resolveSheetDrag(gesture: SheetDragEnd): SheetSnap | 'dismiss' {
  const { from, deltaPx, viewportPx, velocityPxPerMs } = gesture

  if (velocityPxPerMs !== undefined && Math.abs(velocityPxPerMs) >= FLICK_PX_PER_MS) {
    if (velocityPxPerMs < 0) return 'full'
    return from === 'full' ? 'half' : 'dismiss'
  }

  // A zero-height viewport would make every percentage infinite; treat it as "no
  // movement measurable" and leave the sheet where it was.
  if (viewportPx <= 0) return from

  const endedAt = SHEET_SNAP_PERCENT[from] - (deltaPx / viewportPx) * 100
  const candidates: [SheetSnap | 'dismiss', number][] = [
    ['dismiss', DISMISS_PERCENT],
    ['half', SHEET_SNAP_PERCENT.half],
    ['full', SHEET_SNAP_PERCENT.full]
  ]
  return candidates.reduce((best, candidate) => (Math.abs(endedAt - candidate[1]) < Math.abs(endedAt - best[1]) ? candidate : best))[0]
}

/**
 * The height to paint mid-drag, in px, clamped to the sheet's own range.
 *
 * Clamped rather than free so the gesture cannot paint a sheet taller than its tallest
 * snap — dragging up past `full` would otherwise stretch it over the whole viewport and
 * then spring back, which reads as a bug rather than as a limit.
 */
export function sheetDragHeight(gesture: Omit<SheetDragEnd, 'velocityPxPerMs'>): number {
  const { from, deltaPx, viewportPx } = gesture
  const startPx = (SHEET_SNAP_PERCENT[from] / 100) * viewportPx
  const maxPx = (SHEET_SNAP_PERCENT.full / 100) * viewportPx
  return Math.max(0, Math.min(maxPx, startPx - deltaPx))
}

/**
 * The fraction of its own height an auto-height sheet must travel to be let go of.
 *
 * Generous, and it can afford to be: a drag can only START on the handle, so unlike the
 * snapping sheet there is no scroll gesture it could be confused with — a downward pull on
 * the handle has exactly one meaning. Measured on the device first at a third capped at
 * 160px, which made an ordinary thumb-length pull do nothing at all on a sheet that had
 * grown to 92vh from eleven actions.
 */
const DISMISS_TRAVEL_FRACTION = 1 / 4
/** Never ask for more than this, however tall the sheet is. About two rows. */
const DISMISS_TRAVEL_MAX_PX = 100

export interface SheetDismissDragEnd {
  /** Distance travelled, positive downward. */
  deltaPx: number
  /** The sheet's own height. */
  sheetPx: number
  /** Signed, positive downward. Omit when unmeasurable. */
  velocityPxPerMs?: number
}

/**
 * Whether an auto-height sheet (the action sheet, the share sheet) should close.
 *
 * Upward travel never closes anything: there is nowhere for this kind of sheet to grow to,
 * so a drag up is a mis-grab and springs back.
 */
export function resolveSheetDismissDrag(gesture: SheetDismissDragEnd): boolean {
  const { deltaPx, sheetPx, velocityPxPerMs } = gesture
  if (deltaPx <= 0) return false
  if (velocityPxPerMs !== undefined && velocityPxPerMs >= FLICK_PX_PER_MS) return true
  return deltaPx >= Math.min(DISMISS_TRAVEL_MAX_PX, sheetPx * DISMISS_TRAVEL_FRACTION)
}
