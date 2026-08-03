import { Directive, ElementRef, HostListener, inject, Input, OnDestroy } from '@angular/core'

const DELAY_IN_MS = 400
const GAP = 8
const GUTTER = 8

// Tooltips for icon-only controls.
//
// The design makes one hard demand of every icon-only control — "icon-only only
// when the glyph is unambiguous AND tooltipped" — and one of every tooltip: it
// carries the shortcut. So the shortcut is a separate input rendered in mono
// beside the label, not something the caller concatenates into a string.
//
// 400ms in, none out. The asymmetry is deliberate: a delay stops tooltips firing
// while the pointer crosses a toolbar, and no delay out stops one lingering over
// content after the pointer has left.
//
// Built on a body-appended fixed element rather than an Angular CDK overlay,
// matching what context-menu.component.ts already does in this tree. Two reasons
// it is a directive and not a component: it must attach to elements it does not
// own (any button, any icon), and a `title` attribute — which is what these
// controls use today — cannot be styled, cannot show a mono shortcut, and fires
// on a delay the OS chooses.
//
// SSR-guarded. v2 components render on the server, where there is no document.
@Directive({
  selector: '[appV2Tooltip]'
})
export class TooltipDirective implements OnDestroy {
  /** Tooltip text. An empty value disables the tooltip entirely. */
  @Input('appV2Tooltip') text: string | null = null
  /** Shortcut, rendered in mono to the right of the label. E.g. `⌘I`, `F2`. */
  @Input() tooltipShortcut: string | null = null
  @Input() tooltipPlacement: 'top' | 'bottom' = 'top'

  private readonly host = inject(ElementRef<HTMLElement>)
  private node: HTMLElement | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  // focusin / focusout rather than focus / blur, because focus does not bubble.
  // This directive is usually placed on a COMPONENT host (app-v2-icon-btn), so the
  // element that actually receives focus is the <button> inside it — with `focus`
  // the tooltip worked on hover and was invisible to every keyboard user, which is
  // precisely the population it exists for. mouseenter needs no equivalent fix: it
  // fires on the entered element AND its ancestors.
  @HostListener('mouseenter')
  @HostListener('focusin')
  onEnter(): void {
    if (!this.text || typeof document === 'undefined') return
    this.cancel()
    this.timer = setTimeout(() => this.show(), DELAY_IN_MS)
  }

  @HostListener('mouseleave')
  @HostListener('focusout')
  // A tooltip that survived its trigger's click would sit over whatever the click
  // opened, so a click hides it too.
  @HostListener('click')
  onLeave(): void {
    this.cancel()
    this.hide()
  }

  ngOnDestroy(): void {
    this.cancel()
    this.hide()
  }

  private cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private show(): void {
    if (!this.text) return
    // Reposition an existing node rather than bailing out. mouseenter can fire
    // again without an intervening mouseleave — moving between the host and a
    // child, or a re-entry the browser coalesces — and returning early there left
    // the tooltip pinned wherever it first appeared.
    if (this.node) {
      this.position(this.node)
      return
    }
    const el = document.createElement('div')
    el.className = 'v2-tooltip'
    el.setAttribute('role', 'tooltip')

    const label = document.createElement('span')
    label.textContent = this.text
    el.appendChild(label)

    if (this.tooltipShortcut) {
      const kbd = document.createElement('span')
      kbd.className = 'v2-tooltip__kbd'
      kbd.textContent = this.tooltipShortcut
      el.appendChild(kbd)
    }

    // Mounted inside .v2-root, NOT on document.body. Every --si-* token is
    // scoped to .v2-root, so a body-level node resolves them all to nothing and
    // the tooltip renders as unstyled black-on-transparent text. It is still
    // position:fixed, so it is positioned against the viewport and is not clipped
    // by any ancestor's overflow.
    const root = document.querySelector('.v2-root') ?? document.body
    root.appendChild(el)
    this.node = el
    this.position(el)
  }

  // Measured after insertion, because the width depends on the text. Clamped to
  // the viewport horizontally, and flipped to the other side vertically if the
  // preferred side has no room — a tooltip on a toolbar button at the top of the
  // window would otherwise render off-screen.
  private position(el: HTMLElement): void {
    const a = this.host.nativeElement.getBoundingClientRect()
    const t = el.getBoundingClientRect()

    let top = this.tooltipPlacement === 'top' ? a.top - t.height - GAP : a.bottom + GAP
    if (top < GUTTER) top = a.bottom + GAP
    if (top + t.height > window.innerHeight - GUTTER) top = a.top - t.height - GAP

    let left = a.left + a.width / 2 - t.width / 2
    left = Math.max(GUTTER, Math.min(left, window.innerWidth - t.width - GUTTER))

    el.style.top = `${Math.round(top)}px`
    el.style.left = `${Math.round(left)}px`
    el.style.opacity = '1'
  }

  private hide(): void {
    this.node?.remove()
    this.node = null
  }
}
