// Pins the 409-conflict path of the v2 diagram viewer.
//
// #496: an autosave that loses an optimistic-concurrency race took the FAILED
// payload as "mine" and threw away `queuedXml` — the strictly newer canvas the
// user drew while that save was in flight. "Keep mine" then re-sent the stale
// xml. Nothing looked wrong, because the newest shapes were still on the
// canvas and drawio's autosave only fires on the next change; the user found
// out after closing the tab.
//
// Same no-TestBed approach as office-view.component.spec.ts (see
// screens/files/testing/file-browser-harness.ts for the rationale): a plain
// Injector plus the two internal tokens the component's signal plumbing needs.
// Nothing here renders, so `editorFrame` is stubbed out and `postToEditor` is
// a no-op — the handler under test never reads it back.
//
// DELIBERATELY A SEPARATE FILE from diagram-view.component.spec.ts, which pins
// the read-only / third-party-notice behaviour (#497/#499). The two suites need
// incompatible harnesses: that one drives `ngOnInit` so the GET decides
// `isWritable` and the iframe src, while this one bypasses init entirely and
// assigns the post-load fields, because what it exercises is the save state
// machine and a real load would only re-stub it. Merging them would mean one
// `mount()` with a flag for which half of the component is real.

import { describe, expect, it } from 'vitest'
import { HttpClient } from '@angular/common/http'
import { DestroyRef, Injector, runInInjectionContext, ɵChangeDetectionScheduler, ɵEffectScheduler } from '@angular/core'
import { DomSanitizer } from '@angular/platform-browser'
import { L10N_LOCALE } from 'angular-l10n'
import { Observable, Subject, of } from 'rxjs'
import { DiagramViewComponent } from './diagram-view.component'

class StubEffectScheduler {
  add(): void {
    // discarded: nothing is rendering
  }
  schedule(): void {
    // discarded: nothing is rendering
  }
  remove(): void {
    // discarded: nothing is rendering
  }
}

class StubChangeDetectionScheduler {
  runningTick = false
  notify(): void {
    // no-op: nothing is rendering
  }
}

// The component reaches these from its own template or from private handlers,
// so the spec casts to the surface it drives — same device as office-view's.
interface DiagramViewApi {
  conflict: () => { theirEtag: string; theirXml: string } | null
  saveXml: (xml: string) => void
  keepMine: () => void
  queuedXml: string | null
  etag: string
}

const THEIRS = { etag: 'their-etag', xml: '<mxfile><theirs/></mxfile>', mtime: 1, name: 'd.drawio', isWritable: true, editorUrl: 'https://e.test' }

function mount() {
  const puts: { body: { path: string; xml: string; etag: string }; subject: Subject<{ etag: string; mtime: number }> }[] = []
  const injector = Injector.create({
    providers: [
      { provide: ɵEffectScheduler, useValue: new StubEffectScheduler() },
      { provide: ɵChangeDetectionScheduler, useValue: new StubChangeDetectionScheduler() },
      { provide: DestroyRef, useValue: { onDestroy: () => () => undefined } },
      { provide: L10N_LOCALE, useValue: { language: 'en' } },
      { provide: DomSanitizer, useValue: { bypassSecurityTrustResourceUrl: (u: string) => u } },
      {
        provide: HttpClient,
        useValue: {
          // A Subject per save, so a case controls exactly when the in-flight
          // request resolves — which is the whole point: the bug lives in what
          // arrives WHILE one is open.
          put: (_url: string, body: { path: string; xml: string; etag: string }) => {
            const subject = new Subject<{ etag: string; mtime: number }>()
            puts.push({ body, subject })
            return subject.asObservable() as Observable<{ etag: string; mtime: number }>
          },
          get: () => of(THEIRS)
        }
      }
    ] as never
  })
  const component = runInInjectionContext(injector, () => new DiagramViewComponent())
  // Skips ngOnInit's load: `path`, `etag` and `isWritable` are what it sets,
  // and a real GET would just be the same stub.
  Object.assign(component as unknown as Record<string, unknown>, {
    path: 'files/personal/d.drawio',
    etag: 'mine-etag',
    isWritable: true,
    editorOrigin: 'https://e.test',
    editorFrame: () => undefined
  })
  return { api: component as unknown as DiagramViewApi, puts }
}

describe('DiagramViewComponent conflict handling', () => {
  it('keeps the newest canvas when a save 409s while a newer one is queued', () => {
    const { api, puts } = mount()

    api.saveXml('<mxfile><v1/></mxfile>')
    expect(puts).toHaveLength(1)
    // Drawn while save #1 is still open, so it only reaches `queuedXml`.
    api.saveXml('<mxfile><v2-with-the-new-box/></mxfile>')
    expect(puts).toHaveLength(1)

    puts[0].subject.error({ status: 409 })

    // The refresh is synchronous here, so the dialog is already open.
    expect(api.conflict()).toEqual({ theirEtag: THEIRS.etag, theirXml: THEIRS.xml })

    api.keepMine()

    expect(puts).toHaveLength(2)
    // The box the user drew, not the payload that lost the race.
    expect(puts[1].body.xml).toBe('<mxfile><v2-with-the-new-box/></mxfile>')
    // Rebased onto their etag, or it would 409 forever.
    expect(puts[1].body.etag).toBe(THEIRS.etag)
  })

  it('does not re-send the superseded payload after the conflict resolves', () => {
    const { api, puts } = mount()

    api.saveXml('<mxfile><v1/></mxfile>')
    api.saveXml('<mxfile><v2/></mxfile>')
    puts[0].subject.error({ status: 409 })
    api.keepMine()
    puts[1].subject.next({ etag: 'server-etag', mtime: 2 })
    puts[1].subject.complete()

    // `doSave`'s success branch drains `queuedXml`. If the 409 path had left
    // the stale entry there, this would be a third request putting v2's
    // predecessor back on top of the resolution.
    expect(puts).toHaveLength(2)
    expect(api.queuedXml).toBeNull()
    expect(api.etag).toBe('server-etag')
  })

  it('falls back to the failed payload when nothing was queued', () => {
    const { api, puts } = mount()

    api.saveXml('<mxfile><only/></mxfile>')
    puts[0].subject.error({ status: 409 })
    api.keepMine()

    expect(puts[1].body.xml).toBe('<mxfile><only/></mxfile>')
  })

  it('still drops the queue on a non-409 failure, and opens no dialog', () => {
    const { api, puts } = mount()

    api.saveXml('<mxfile><v1/></mxfile>')
    api.saveXml('<mxfile><v2/></mxfile>')
    puts[0].subject.error({ status: 500 })

    expect(api.conflict()).toBeNull()
    expect(api.queuedXml).toBeNull()
    expect(puts).toHaveLength(1)
  })
})
