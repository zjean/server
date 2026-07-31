// Pins the accessible-name fallback of app-v2-icon-btn.
//
// The button's only content is an <svg>, so it has no text node to name it. Most
// call sites pass a `title`, which is why the unnamed ones went unnoticed: a
// tooltip reads like a label but is not one — AT exposes `title` only as a
// last-resort fallback, and browsers drop it entirely once aria-label is set.
// So `ariaLabel` has to default to `title` rather than replace it, or adding the
// input would have silently un-named every button that only has a tooltip.
//
// No TestBed and no template here (same reason as office-view.component.spec.ts:
// nothing in this suite compiles a template). This component takes no DI, so a
// plain `new` is enough to pin the resolution rule; the binding that consumes it
// is one attribute in the template and is browser-verified in the PR.

import { describe, expect, it } from 'vitest'
import { IconButtonComponent } from './icon-button.component'

describe('IconButtonComponent', () => {
  const btn = (): IconButtonComponent => {
    const c = new IconButtonComponent()
    c.iconName = 'more'
    return c
  }

  describe('resolvedAriaLabel', () => {
    it('falls back to the title when no ariaLabel is given', () => {
      const c = btn()
      c.title = 'Refresh'
      expect(c.resolvedAriaLabel).toBe('Refresh')
    })

    it('prefers an explicit ariaLabel over the title', () => {
      const c = btn()
      c.title = 'More'
      c.ariaLabel = 'More actions for report.pdf'
      expect(c.resolvedAriaLabel).toBe('More actions for report.pdf')
    })

    it('uses the ariaLabel when there is no title', () => {
      const c = btn()
      c.ariaLabel = 'Close transfers'
      expect(c.resolvedAriaLabel).toBe('Close transfers')
    })

    it('stays null when neither is given, so no empty aria-label is emitted', () => {
      expect(btn().resolvedAriaLabel).toBeNull()
    })
  })
})
