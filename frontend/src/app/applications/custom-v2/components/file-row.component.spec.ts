// Pins the auxclick button guard.
//
// Worth a test because the bug it prevents is silent and annoying rather than
// loud: `auxclick` fires for the middle button AND, in some browsers, the right
// button. A handler that forwards every auxclick makes a right-click open the
// file in a new tab at the same time as the context menu appears — two responses
// to one gesture, and only on some browsers, which is the shape of thing that
// survives manual testing.
//
// No TestBed and no template, following the file-browser harness: a plain
// `Injector` plus `runInInjectionContext`, with no platform and no DOM. The
// component takes no DI of its own, but `input()` and `output()` are injection-
// context APIs, so a bare `new` throws NG0203 — which is the one difference from
// icon-button.component.spec.ts, whose component uses `@Input()` decorators and
// can be constructed directly.
//
// The event objects are minimal stand-ins: only `button` and `preventDefault` are
// touched.

import { Injector, runInInjectionContext } from '@angular/core'
import { describe, expect, it, vi } from 'vitest'
import { FileRowComponent } from './file-row.component'

const makeRow = (): FileRowComponent => runInInjectionContext(Injector.create({ providers: [] }), () => new FileRowComponent())

// The guard lives on a protected member; reaching it through an index signature
// keeps the component's public surface honest rather than widening it for a test.
const onAuxClick = (c: FileRowComponent, e: MouseEvent): void => (c as unknown as { onAuxClick(e: MouseEvent): void }).onAuxClick(e)

const mouseEvent = (button: number) => {
  const preventDefault = vi.fn()
  return { event: { button, preventDefault } as unknown as MouseEvent, preventDefault }
}

describe('FileRowComponent', () => {
  describe('onAuxClick', () => {
    it('emits aux for the middle button', () => {
      const c = makeRow()
      const emitted: MouseEvent[] = []
      c.aux.subscribe((e) => emitted.push(e))

      const { event } = mouseEvent(1)
      onAuxClick(c, event)

      expect(emitted).toHaveLength(1)
    })

    it('suppresses the browser default for the middle button', () => {
      // Without this, Chromium also starts autoscroll on middle click.
      const c = makeRow()
      const { event, preventDefault } = mouseEvent(1)
      onAuxClick(c, event)
      expect(preventDefault).toHaveBeenCalledOnce()
    })

    it('ignores the right button, so a context menu does not also open a tab', () => {
      const c = makeRow()
      const emitted: MouseEvent[] = []
      c.aux.subscribe((e) => emitted.push(e))

      const { event, preventDefault } = mouseEvent(2)
      onAuxClick(c, event)

      expect(emitted).toHaveLength(0)
      expect(preventDefault).not.toHaveBeenCalled()
    })

    it('ignores the left button', () => {
      const c = makeRow()
      const emitted: MouseEvent[] = []
      c.aux.subscribe((e) => emitted.push(e))
      onAuxClick(c, mouseEvent(0).event)
      expect(emitted).toHaveLength(0)
    })
  })
})
