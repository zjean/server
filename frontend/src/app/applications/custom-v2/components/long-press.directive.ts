import { Directive, HostListener, input, OnDestroy, output } from '@angular/core'

/** How long a finger has to stay down. Android's own long-press threshold is 500ms. */
const LONG_PRESS_MS = 450
/** Movement past this is a scroll, not a press. */
const MOVE_TOLERANCE_PX = 10
/**
 * How long the swallowing click listener may survive if no click ever arrives. A press
 * that ends in a scroll or on a removed element produces no click at all, and a listener
 * left armed would eat an unrelated one.
 */
const CLICK_SWALLOW_MS = 400

/**
 * Long-press, for touch only.
 *
 * `M6`'s entry point into bulk selection, and on a phone the ONLY one: the row
 * checkboxes are `opacity: 0` until `:hover` or `.file-table--selecting`, and a
 * touchscreen has no hover — so before this, a selection could not be started at all on
 * mobile, which also put the inspector out of reach (it describes the selected row).
 *
 * Two things it has to do beyond starting a timer:
 *
 *  • **Ignore a mouse.** A desktop user has right-click for the same menu and a
 *    press-and-hold that silently changed the selection would be a surprise. `pen` is
 *    treated as touch: it has no hover either.
 *  • **Swallow the click that follows.** The browser still fires one, and the row's own
 *    handler reads a click on the single selected file as "open it" — so a long-press
 *    would select the row and then immediately navigate away from it. The listener goes
 *    on the document in the CAPTURE phase, which is the only place guaranteed to run
 *    before a handler bound on the element itself.
 */
@Directive({
  selector: '[appV2LongPress]'
})
export class LongPressDirective implements OnDestroy {
  /** Set to false to disarm — e.g. on a screen where selection means nothing. */
  readonly longPressEnabled = input(true)

  readonly longPress = output<void>()

  private timer: ReturnType<typeof setTimeout> | null = null
  private swallowTimer: ReturnType<typeof setTimeout> | null = null
  private startX = 0
  private startY = 0
  private readonly swallowClick = (event: MouseEvent): void => {
    event.stopPropagation()
    event.preventDefault()
    this.disarmSwallow()
  }

  @HostListener('pointerdown', ['$event'])
  protected onPointerDown(event: PointerEvent): void {
    if (!this.longPressEnabled()) return
    if (event.pointerType === 'mouse') return
    this.startX = event.clientX
    this.startY = event.clientY
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      this.armSwallow()
      this.longPress.emit()
    }, LONG_PRESS_MS)
  }

  @HostListener('pointermove', ['$event'])
  protected onPointerMove(event: PointerEvent): void {
    if (this.timer === null) return
    const moved = Math.abs(event.clientX - this.startX) > MOVE_TOLERANCE_PX || Math.abs(event.clientY - this.startY) > MOVE_TOLERANCE_PX
    if (moved) this.clearTimer()
  }

  @HostListener('pointerup')
  @HostListener('pointercancel')
  @HostListener('pointerleave')
  protected onPointerEnd(): void {
    this.clearTimer()
  }

  ngOnDestroy(): void {
    this.clearTimer()
    this.disarmSwallow()
  }

  private clearTimer(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }

  private armSwallow(): void {
    if (typeof document === 'undefined') return
    this.disarmSwallow()
    document.addEventListener('click', this.swallowClick, { capture: true })
    this.swallowTimer = setTimeout(() => this.disarmSwallow(), CLICK_SWALLOW_MS)
  }

  private disarmSwallow(): void {
    if (typeof document !== 'undefined') document.removeEventListener('click', this.swallowClick, { capture: true })
    if (this.swallowTimer !== null) {
      clearTimeout(this.swallowTimer)
      this.swallowTimer = null
    }
  }
}
