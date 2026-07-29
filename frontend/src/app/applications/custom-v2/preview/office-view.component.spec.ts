// Pins the editor-load-error path of the v2 office viewer.
//
// #376: `(loadError)` was unbound, so when the document server's api.js failed
// to load, OnlyOfficeComponent's error went nowhere and the pane stayed blank
// forever. The `error()` signal is only otherwise set by the /settings HTTP
// path, which has already SUCCEEDED by the time this failure happens — that is
// why the blank pane had no other way to surface.
//
// Same no-TestBed approach as the file-browser harness (see
// screens/files/testing/file-browser-harness.ts for the rationale): a plain
// Injector plus the two internal tokens `effect()` needs. This component's
// `path`/`file` are required signal inputs, which cannot be set outside a
// template — so this spec never flushes effects and never reads them. The
// handler under test doesn't touch either.
//
// What this CANNOT pin is the template binding itself, since nothing here
// compiles a template — and the missing binding *was* the bug. That half is
// browser-verified (see the PR); a rendering test needs the harness work in #347.

import { describe, expect, it } from 'vitest'
import { HttpClient } from '@angular/common/http'
import { DestroyRef, Injector, runInInjectionContext, signal, ɵChangeDetectionScheduler, ɵEffectScheduler } from '@angular/core'
import { L10N_LOCALE } from 'angular-l10n'
import { FILE_MODE } from '@sync-in-server/backend/src/applications/files/constants/operations'
import { BehaviorSubject } from 'rxjs'
import { StoreService } from '../../../store/store.service'
import type { OnlyOfficeHistoryHooks } from '../models/only-office-history.model'
import { EditorHistoryService } from '../services/editor-history.service'
import { VersionsService, type VersionsAvailability } from '../services/versions.service'
import { OfficeViewComponent } from './office-view.component'

// The component only reaches `protected` members from its own template, so the
// spec casts to the surface it exercises — same device as BrowserApi.
interface OfficeViewApi {
  error: () => string | null
  errorDetail: () => string | null
  officeEditorName: string
  onLoadError: (e: { title: string; message: string }) => void
  config: { set: (v: unknown) => void }
  historyHooks: () => OnlyOfficeHistoryHooks | undefined
}

// Effects are never flushed here — the component's effect would dereference the
// unset required inputs and throw — so this scheduler deliberately drops them
// rather than queueing them like the file-browser harness does.
class StubEffectScheduler {
  add(): void {
    // discarded: see note above
  }
  schedule(): void {
    // discarded: see note above
  }
  remove(): void {
    // discarded: see note above
  }
}

class StubChangeDetectionScheduler {
  runningTick = false
  notify(): void {
    // no-op: nothing is rendering
  }
}

function mount(editors: { onlyoffice: boolean; eurooffice: boolean; collabora: boolean }, opts: { availability?: VersionsAvailability } = {}) {
  const injector = Injector.create({
    providers: [
      { provide: ɵEffectScheduler, useValue: new StubEffectScheduler() },
      { provide: ɵChangeDetectionScheduler, useValue: new StubChangeDetectionScheduler() },
      { provide: DestroyRef, useValue: { onDestroy: () => () => undefined } },
      { provide: L10N_LOCALE, useValue: { language: 'en' } },
      { provide: HttpClient, useValue: { get: () => new BehaviorSubject(null).asObservable() } },
      // Only `availability` and `probe` are reached from this component.
      { provide: VersionsService, useValue: { availability: signal(opts.availability ?? 'unknown'), probe: () => undefined } },
      // useClass, not a pre-built instance: the service `inject()`s HttpClient in
      // a field initializer, so it has to be constructed BY the injector.
      { provide: EditorHistoryService, useClass: EditorHistoryService },
      {
        provide: StoreService,
        useValue: {
          server: () => ({ files: { editors } }),
          user: new BehaviorSubject({ login: 'sync-in', fullName: 'Sync-in Admin', email: 's@e.test' })
        }
      }
    ] as never
  })
  const component = runInInjectionContext(injector, () => new OfficeViewComponent()) as unknown as OfficeViewApi
  // `path` is a required signal input, which cannot be set from outside a
  // template — but historyHooks() reads it, so the gating cases would throw on
  // the one path that gets as far as building hooks. Overwriting the property
  // with a plain signal is the same device the file-browser harness uses for
  // inputs it has to drive without a template.
  ;(component as unknown as { path: unknown }).path = signal('files/personal/docs/report.docx')
  return component
}

// An editor config as /settings answers it, trimmed to what historyHooks reads.
const settings = (over: { mode?: FILE_MODE; token?: string | null } = {}) => ({
  documentServerUrl: 'https://docs.test',
  config: {
    document: { url: over.token === null ? 'https://files.test/doc/a.docx' : `https://files.test/doc/a.docx?token=${over.token ?? 'office-jwt'}` },
    editorConfig: { mode: over.mode ?? FILE_MODE.EDIT }
  }
})

const ALL_OFF = { onlyoffice: false, eurooffice: false, collabora: false }

describe('office view — editor load error (#376)', () => {
  it('surfaces a translatable headline key rather than the emitted English title', () => {
    const c = mount({ ...ALL_OFF, onlyoffice: true })
    c.onLoadError({ title: 'Unable to load OnlyOffice editor', message: 'The document server may be unreachable' })
    // A key, not the pre-interpolated title — the template translates it with
    // { editor }, so it localizes AND names the configured provider.
    expect(c.error()).toBe('v2_office_load_failed')
  })

  it('keeps the emitted message as technical detail', () => {
    const c = mount({ ...ALL_OFF, onlyoffice: true })
    c.onLoadError({ title: 'Unable to load OnlyOffice editor', message: 'The document server may be unreachable' })
    expect(c.errorDetail()).toBe('The document server may be unreachable')
  })

  it('preserves the diagnostic code for an unknown failure', () => {
    const c = mount({ ...ALL_OFF, onlyoffice: true })
    c.onLoadError({ title: 'Unknown OnlyOffice error', message: 'Code: -1' })
    expect(c.errorDetail()).toBe('Code: -1')
  })

  it('starts with no error, so the pane only shows one after a real failure', () => {
    const c = mount({ ...ALL_OFF, onlyoffice: true })
    expect(c.error()).toBe(null)
    expect(c.errorDetail()).toBe(null)
  })

  // The headline's {{ editor }} placeholder is filled from officeEditorName, so
  // the Euro-Office deployment #301 cared about gets its own name here. This is
  // the assertion #306's "the message names Euro-Office" box was after — it was
  // unreachable while (loadError) was unbound.
  it('names Euro-Office when that is the configured provider', () => {
    const c = mount({ ...ALL_OFF, eurooffice: true })
    expect(c.officeEditorName).toBe('Euro-Office')
  })

  it('names OnlyOffice when it is enabled, which wins over Euro-Office', () => {
    const c = mount({ ...ALL_OFF, onlyoffice: true, eurooffice: true })
    expect(c.officeEditorName).toBe('OnlyOffice')
  })
})

// The gate on the in-editor version panel.
//
// `historyHooks` being UNDEFINED rather than `{}` is the whole mechanism: the
// editor decides whether to offer a version affordance by whether
// `onRequestHistory` exists in the events it was given, so every "no panel" case
// has to produce nothing at all.
describe('office view — the in-editor version panel gate', () => {
  const ON = { ...ALL_OFF, onlyoffice: true }

  it('offers the hooks for an editable session on a server with versioning on', () => {
    const c = mount(ON, { availability: 'available' })
    c.config.set(settings())

    const h = c.historyHooks()
    // All four, because a partial set is a panel that opens and cannot be used.
    expect(h?.onRequestHistory).toBeTypeOf('function')
    expect(h?.onRequestHistoryData).toBeTypeOf('function')
    expect(h?.onRequestRestore).toBeTypeOf('function')
    expect(h?.onRequestHistoryClose).toBeTypeOf('function')
  })

  // `files.versions.enabled` defaults to false, and every version endpoint 404s
  // while it is off. Offering the panel there would open an empty pane.
  it('offers nothing while versioning is unavailable', () => {
    const c = mount(ON, { availability: 'unavailable' })
    c.config.set(settings())
    expect(c.historyHooks()).toBeUndefined()
  })

  // 'unknown' means the probe has not answered yet. Erring toward no panel means
  // the affordance appears once the answer arrives rather than appearing and then
  // failing.
  it('offers nothing before the probe has settled', () => {
    const c = mount(ON, { availability: 'unknown' })
    c.config.set(settings())
    expect(c.historyHooks()).toBeUndefined()
  })

  // A read-only session that offers Restore is worse than no panel: the button is
  // there and the server refuses it. The backend route carries MODIFY, so this is
  // the honest UI rather than the security boundary.
  it('offers nothing in a VIEW-mode session', () => {
    const c = mount(ON, { availability: 'available' })
    c.config.set(settings({ mode: FILE_MODE.VIEW }))
    expect(c.historyHooks()).toBeUndefined()
  })

  // Without the ONLY_OFFICE token there is no url the document server could
  // fetch, so every entry would render empty.
  it('offers nothing when the config carries no editor token', () => {
    const c = mount(ON, { availability: 'available' })
    c.config.set(settings({ token: null }))
    expect(c.historyHooks()).toBeUndefined()
  })

  it('offers nothing before the config has arrived', () => {
    const c = mount(ON, { availability: 'available' })
    expect(c.historyHooks()).toBeUndefined()
  })
})
