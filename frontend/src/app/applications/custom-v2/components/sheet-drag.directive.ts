import { Directive, ElementRef, HostListener, inject, input, model, output } from '@angular/core'
import { resolveSheetDismissDrag, resolveSheetDrag, sheetDragHeight, SheetSnap } from '../utils/sheet-snap'

/** How far a pointer may wander before a tap on the handle counts as a drag. */
const TAP_SLOP_PX = 4

/**
 * Drag-to-snap for a `.v2-sheet`.
 *
 * Put it on the sheet element; it listens for `pointerdown` on the `.v2-sheet__handle`
 * inside itself, so a caller wires one attribute rather than three handlers, and the
 * handle stays a plain element in the template.
 *
 * ```html
 * <aside class="v2-sheet" [class.v2-sheet--full]="snap() === 'full'" appV2SheetDrag [(snap)]="snap" (dismissed)="close()">
 *   <button class="v2-sheet__handle" type="button" (click)="toggleSnap()"></button>
 * ```
 *
 * Three implementation notes, each of them a thing that does not work otherwise:
 *
 *  • **Height is written imperatively during the gesture, not through a signal.** A
 *    signal write per `pointermove` is a change-detection pass per frame for a value
 *    only one element reads; and the sheet's own `transition: height` has to be off
 *    while the finger is down, which is a class the same code toggles. So the directive
 *    owns the style during a drag and hands it back on release.
 *  • **No `requestAnimationFrame`.** Not for the harness's sake — this is verified on a
 *    real device — but because coalescing pointer moves into frames adds a frame of lag
 *    to a gesture whose whole job is to track the thumb. `pointermove` is already
 *    throttled to the compositor by the browser.
 *  • **`setPointerCapture` on the handle**, so the gesture survives the pointer leaving
 *    the 40px pill — which it does immediately, since the sheet moves out from under it.
 */
@Directive({
  selector: '[appV2SheetDrag]'
})
export class SheetDragDirective {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef)

  /**
   * `snap` for a sheet with the design's two heights; `dismiss` for an auto-height one,
   * where the only thing a downward drag can mean is "away". The second mode moves the
   * sheet with `translateY` rather than resizing it — there is no height to interpolate
   * towards, and translating is what makes the spring-back free.
   */
  readonly dragMode = input<'snap' | 'dismiss'>('snap')

  /** Two-way: the directive resolves the gesture, the host keeps the state. Snap mode only. */
  readonly snap = model<SheetSnap>('half')
  /** The gesture asked for the sheet to go away. The host decides what that means. */
  readonly dismissed = output<void>()

  private startY = 0
  private startAt = 0
  private startedFrom: SheetSnap = 'half'
  private lastY = 0
  private lastAt = 0
  private dragging = false
  private moved = false

  @HostListener('pointerdown', ['$event'])
  protected onPointerDown(event: PointerEvent): void {
    const target = event.target as HTMLElement | null
    if (!target?.closest('.v2-sheet__handle')) return
    // A secondary button or a two-finger gesture is not a drag.
    if (event.button !== 0) return

    this.dragging = true
    this.moved = false
    this.startedFrom = this.snap()
    this.startY = this.lastY = event.clientY
    this.startAt = this.lastAt = event.timeStamp
    target.setPointerCapture?.(event.pointerId)
    this.host.nativeElement.classList.add('v2-sheet--dragging')
  }

  @HostListener('pointermove', ['$event'])
  protected onPointerMove(event: PointerEvent): void {
    if (!this.dragging) return
    const deltaPx = event.clientY - this.startY
    if (!this.moved && Math.abs(deltaPx) < TAP_SLOP_PX) return
    this.moved = true
    this.lastY = event.clientY
    this.lastAt = event.timeStamp
    // Prevents the pull-to-refresh / overscroll the browser would otherwise start on
    // top of the drag.
    event.preventDefault()
    if (this.dragMode() === 'dismiss') {
      // Downward only: an auto-height sheet has nowhere to grow to.
      this.host.nativeElement.style.transform = `translateY(${Math.max(0, deltaPx)}px)`
      return
    }
    this.host.nativeElement.style.height = `${sheetDragHeight({
      from: this.startedFrom,
      deltaPx,
      viewportPx: this.viewportHeight()
    })}px`
  }

  @HostListener('pointerup', ['$event'])
  @HostListener('pointercancel', ['$event'])
  protected onPointerUp(event: PointerEvent): void {
    if (!this.dragging) return
    this.dragging = false
    const element = this.host.nativeElement
    element.classList.remove('v2-sheet--dragging')
    // Hand the geometry back to the classes; leaving an inline value would pin the sheet
    // at whatever the gesture ended on and beat every later class change.
    element.style.removeProperty('height')
    element.style.removeProperty('transform')

    // A tap on the handle is not a drag, and it must not resolve as one — with no
    // movement, `resolveSheetDrag` would report the nearest snap, which is the one it is
    // already at. Handled by the host's own click handler instead.
    if (!this.moved) return

    if (this.dragMode() === 'dismiss') {
      if (
        resolveSheetDismissDrag({
          deltaPx: event.clientY - this.startY,
          sheetPx: element.getBoundingClientRect().height,
          velocityPxPerMs: this.velocity(event)
        })
      ) {
        this.dismissed.emit()
      }
      return
    }

    const outcome = resolveSheetDrag({
      from: this.startedFrom,
      deltaPx: event.clientY - this.startY,
      viewportPx: this.viewportHeight(),
      velocityPxPerMs: this.velocity(event)
    })
    if (outcome === 'dismiss') {
      this.dismissed.emit()
      return
    }
    this.snap.set(outcome)
  }

  /**
   * Speed over the last move only, not over the whole gesture: a slow drag that ends
   * with a flick is a flick, and averaging from `pointerdown` would read it as slow.
   * Undefined when there is no interval to divide by — the resolver takes that as
   * "unmeasurable" and falls back to geometry.
   */
  private velocity(event: PointerEvent): number | undefined {
    const ms = event.timeStamp - this.lastAt
    if (ms <= 0) return undefined
    return (event.clientY - this.lastY) / ms
  }

  private viewportHeight(): number {
    return typeof window === 'undefined' ? 0 : window.innerHeight
  }
}
