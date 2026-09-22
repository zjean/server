// Pins the read-only path of the v2 diagram viewer (#497).
//
// Before this, `isWritable` was consulted in exactly one place — a `return` at
// the top of `saveXml` — while the iframe was mounted with `autosave=1` and a
// fully editable canvas. A user with read-only access to a shared space could
// edit for twenty minutes and lose every change with no error and no hint.
//
// Same no-TestBed approach as office-view.component.spec.ts: a plain `Injector`
// plus the internal tokens, no platform and no rendering. What that cannot pin
// is the banner markup itself, since nothing here compiles a template — the
// assertions below are on the signal the banner binds to.

import { describe, expect, it, vi } from 'vitest'
import { HttpClient } from '@angular/common/http'
import { DestroyRef, Injector, runInInjectionContext, ɵChangeDetectionScheduler, ɵEffectScheduler } from '@angular/core'
import { DomSanitizer } from '@angular/platform-browser'
import { L10N_LOCALE } from 'angular-l10n'
import { of } from 'rxjs'
import { DiagramViewComponent } from './diagram-view.component'

const EDITOR_URL = 'https://embed.diagrams.net'

interface DiagramViewApi {
  readOnly: () => boolean
  externalEditorHost: () => string | null
  onMessage: (event: { origin: string; data: unknown }) => void
}

class StubEffectScheduler {
  add(): void {
    // discarded: nothing renders here
  }
  schedule(): void {
    // discarded
  }
  remove(): void {
    // discarded
  }
}

class StubChangeDetectionScheduler {
  runningTick = false
  notify(): void {
    // no-op
  }
}

function mount(isWritable: boolean, editorUrl: string = EDITOR_URL) {
  const put = vi.fn(() => of({ etag: 'new', mtime: 1 }))
  const injector = Injector.create({
    providers: [
      { provide: ɵEffectScheduler, useValue: new StubEffectScheduler() },
      { provide: ɵChangeDetectionScheduler, useValue: new StubChangeDetectionScheduler() },
      { provide: DestroyRef, useValue: { onDestroy: () => () => undefined } },
      { provide: L10N_LOCALE, useValue: { language: 'en' } },
      {
        provide: HttpClient,
        useValue: {
          get: () => of({ xml: '<mxfile/>', etag: 'abc', mtime: 0, name: 'f.drawio', isWritable, editorUrl }),
          put
        }
      },
      // The real sanitizer needs a platform; the component only ever hands the
      // result straight to the template, so the identity function is enough and
      // lets the spec read the URL back.
      { provide: DomSanitizer, useValue: { bypassSecurityTrustResourceUrl: (v: string) => v } }
    ]
  })
  const component = runInInjectionContext(injector, () => new DiagramViewComponent())
  component.path = 'files/spaces/shared/f.drawio'
  component.ngOnInit()
  return { component: component as unknown as DiagramViewApi, src: component['iframeSrc']() as unknown as string, put }
}

describe('DiagramViewComponent read-only mode', () => {
  it('mounts the drawio viewer, not the editor, when the server says the file is not writable', () => {
    const { component, src } = mount(false)
    expect(component.readOnly()).toBe(true)
    // chrome=0 is drawio's viewer switch; autosave must not be armed for a
    // document whose saves can only ever be thrown away.
    expect(src).toContain('chrome=0')
    expect(src).not.toContain('autosave=1')
  })

  it('mounts the editor with autosave when the file is writable', () => {
    const { component, src } = mount(true)
    expect(component.readOnly()).toBe(false)
    expect(src).toContain('autosave=1')
    expect(src).not.toContain('chrome=0')
  })

  it('does not PUT a save that arrives anyway on a read-only document', () => {
    const { component, put } = mount(false)
    component.onMessage({ origin: EDITOR_URL, data: JSON.stringify({ event: 'autosave', xml: '<mxfile><edited/></mxfile>' }) })
    expect(put).not.toHaveBeenCalled()
  })

  it('tells drawio itself the document is read-only on init', () => {
    // `chrome=0` removes the editing UI; this is the second channel — drawio's
    // own status line, where a user wondering why the toolbar is gone will look.
    const { component } = mount(false)
    const posted: unknown[] = []
    // No view is rendered, so there is no real iframe; capture what the
    // component would have posted to it.
    ;(component as unknown as { postToEditor: (m: unknown) => void }).postToEditor = (m) => posted.push(m)
    component.onMessage({ origin: EDITOR_URL, data: JSON.stringify({ event: 'init' }) })
    expect(posted).toContainEqual({ action: 'status', message: 'Read-only' })
  })

  it('does not tell drawio the document is read-only when it is writable', () => {
    const { component } = mount(true)
    const posted: unknown[] = []
    ;(component as unknown as { postToEditor: (m: unknown) => void }).postToEditor = (m) => posted.push(m)
    component.onMessage({ origin: EDITOR_URL, data: JSON.stringify({ event: 'init' }) })
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({ action: 'load' })
  })

  it('still PUTs a save on a writable document', () => {
    const { component, put } = mount(true)
    component.onMessage({ origin: EDITOR_URL, data: JSON.stringify({ event: 'save', xml: '<mxfile><edited/></mxfile>' }) })
    expect(put).toHaveBeenCalledTimes(1)
  })
})

// #499. The default editor is a third party that receives the complete XML of
// every diagram opened, and nothing in the UI used to say so.
describe('DiagramViewComponent third-party editor notice', () => {
  it('names the host when the editor is not this server', () => {
    const { component } = mount(true, 'https://embed.diagrams.net')
    expect(component.externalEditorHost()).toBe('embed.diagrams.net')
  })

  it('names a self-hosted third-party deployment too — "not ours" is the test, not "diagrams.net"', () => {
    const { component } = mount(true, 'https://drawio.example.internal/webapp')
    expect(component.externalEditorHost()).toBe('drawio.example.internal')
  })

  it('says nothing when the editor is served from this origin', () => {
    // These specs run in `environment: node`, which has no `location`; the
    // component compares against `globalThis.location?.origin`, so give it one.
    const g = globalThis as Record<string, unknown>
    const saved = g['location']
    g['location'] = { origin: 'https://files.example.com' }
    try {
      const { component } = mount(true, 'https://files.example.com/drawio/')
      expect(component.externalEditorHost()).toBeNull()
    } finally {
      if (saved === undefined) delete g['location']
      else g['location'] = saved
    }
  })

  it('discloses rather than stays silent when the page origin cannot be read', () => {
    // No `location` at all (SSR, or a hostile stripping of it): the safe answer
    // is to say the content is leaving, not to assume it is not.
    expect(globalThis.location).toBeUndefined()
    const { component } = mount(true, 'https://embed.diagrams.net')
    expect(component.externalEditorHost()).toBe('embed.diagrams.net')
  })
})
