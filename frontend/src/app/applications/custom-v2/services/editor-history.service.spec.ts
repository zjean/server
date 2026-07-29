// The four editor-history handlers, and the token lift they depend on.
//
// This is the half of the feature that is pure logic, and it is where the
// protocol's asymmetries bite: the ordinal arrives as `event.data` for one event
// and `event.data.version` for another, `created` has to become a locale STRING
// before the editor sees it, and `currentVersion` is computed here rather than
// sent. Each of those is a silent failure if wrong — an empty panel, entries
// dated to 1970, or a 404 that reads like a missing version.
//
// Same no-TestBed approach as the rest of the v2 specs: a plain Injector, no
// platform. See screens/files/testing/file-browser-harness.ts for the rationale.

import { describe, expect, it, vi } from 'vitest'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { Injector, runInInjectionContext } from '@angular/core'
import { of, throwError } from 'rxjs'
import type { EditorHistoryEntry } from '@sync-in-server/backend/src/applications/custom-versioning/interfaces/editor-history.interface'
import { EditorHistoryService } from './editor-history.service'

interface HttpStub {
  get: ReturnType<typeof vi.fn>
  post: ReturnType<typeof vi.fn>
}

function mount(http: Partial<HttpStub> = {}) {
  const stub: HttpStub = { get: vi.fn(), post: vi.fn(), ...http } as HttpStub
  const injector = Injector.create({ providers: [{ provide: HttpClient, useValue: stub }] as never })
  const service = runInInjectionContext(injector, () => new EditorHistoryService())
  return { service, http: stub }
}

// Two past revisions plus the live entry, as the backend serves them: oldest
// first, live last, `created` in unix SECONDS.
const HISTORY: EditorHistoryEntry[] = [
  { created: 1_700_000_000, key: '42_100', version: 1, user: { id: 'alice', name: 'Alice Anderson' } },
  { created: 1_700_000_100, key: '42_200', version: 2 },
  { created: 1_700_000_200, key: 'abc-def', version: 3 }
]

// A DocEditor stand-in. The instance is looked up lazily on every call, which is
// what lets a re-mount after a restore be safe — so the double is a getter, not
// an object.
function editorDouble() {
  const calls = { refreshHistory: [] as unknown[], setHistoryData: [] as unknown[] }
  const editor = {
    refreshHistory: (d: unknown) => calls.refreshHistory.push(d),
    setHistoryData: (d: unknown) => calls.setHistoryData.push(d)
  }
  return { editor, calls }
}

const hooks = (service: EditorHistoryService, editor: ReturnType<typeof editorDouble>['editor'], extra: Record<string, unknown> = {}) =>
  service.hooksFor({
    spacePath: 'files/personal/docs/report.docx',
    officeToken: 'office-jwt',
    editor: () => editor,
    locale: 'en-GB',
    ...extra
  })

describe('EditorHistoryService — the token lift', () => {
  // OnlyOfficeManager appends the token to the document url it hands the page
  // (only-office-manager.service.ts:258-262), so the page already holds exactly
  // the credential the document server needs. Lifting it is what avoids a second
  // signing site.
  it('lifts the token out of the config document url', () => {
    const { service } = mount()
    expect(service.officeTokenFrom('https://files.test/api/app/spaces/onlyoffice/document/files/personal/a.docx?token=abc.def.ghi')).toBe(
      'abc.def.ghi'
    )
  })

  // The url is legitimately relative in some deployments, so parsing must not
  // depend on an origin being present.
  it('lifts the token from a RELATIVE url', () => {
    const { service } = mount()
    expect(service.officeTokenFrom('/api/app/spaces/onlyoffice/document/files/personal/a.docx?token=xyz')).toBe('xyz')
  })

  // Null is the honest signal that the panel cannot work for this session: the
  // caller then leaves the hooks off rather than wiring handlers that produce
  // urls the document server rejects.
  it('answers null for a url with no token, an absent url, or an unparseable one', () => {
    const { service } = mount()
    expect(service.officeTokenFrom('https://files.test/doc/a.docx')).toBeNull()
    expect(service.officeTokenFrom(undefined)).toBeNull()
    expect(service.officeTokenFrom('')).toBeNull()
  })
})

describe('EditorHistoryService — onRequestHistory', () => {
  it('hands the panel locale-formatted dates, not the unix seconds the server sent', async () => {
    const { service, http } = mount({ get: vi.fn().mockReturnValue(of(HISTORY)) })
    const { editor, calls } = editorDouble()

    await hooks(service, editor).onRequestHistory!()

    const data = calls.refreshHistory[0] as { history: { created: string }[] }
    // A STRING, because the editor displays this text rather than parsing it
    // (editor.js:734-735). Leaving it numeric shows a raw epoch in the panel.
    expect(typeof data.history[0].created).toBe('string')
    expect(data.history[0].created).toBe(
      new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(1_700_000_000_000))
    )
    expect(http.get).toHaveBeenCalledOnce()
  })

  // The server does not send currentVersion — editor.js derives it as the array
  // maximum, and the live entry being last is what makes that mean "now".
  it('computes currentVersion as the highest ordinal, which is the live entry', async () => {
    const { service } = mount({ get: vi.fn().mockReturnValue(of(HISTORY)) })
    const { editor, calls } = editorDouble()

    await hooks(service, editor).onRequestHistory!()

    expect((calls.refreshHistory[0] as { currentVersion: number }).currentVersion).toBe(3)
  })

  it('preserves the ordinals and keys untouched', async () => {
    const { service } = mount({ get: vi.fn().mockReturnValue(of(HISTORY)) })
    const { editor, calls } = editorDouble()

    await hooks(service, editor).onRequestHistory!()

    const data = calls.refreshHistory[0] as { history: { version: number; key: string }[] }
    expect(data.history.map((r) => r.version)).toEqual([1, 2, 3])
    expect(data.history.map((r) => r.key)).toEqual(['42_100', '42_200', 'abc-def'])
  })

  // The editor renders whatever `error` it is handed, so a failure shows in the
  // panel instead of as a spinner that never resolves.
  it('hands the panel an error rather than leaving it loading', async () => {
    const { service } = mount({
      get: vi.fn().mockReturnValue(throwError(() => new HttpErrorResponse({ status: 500, error: { message: 'boom' } })))
    })
    const { editor, calls } = editorDouble()

    await hooks(service, editor).onRequestHistory!()

    expect(calls.refreshHistory[0]).toEqual({ error: 'boom' })
  })
})

describe('EditorHistoryService — onRequestHistoryData', () => {
  // The ordinal is `event.data` HERE and `event.data.version` in onRequestRestore.
  // Upstream's inconsistency (editor.js:241 vs :255); reading the wrong one sends
  // `undefined` and the server 404s.
  it('reads the ordinal from event.data and asks for that version', async () => {
    const { service, http } = mount({ get: vi.fn().mockReturnValue(of({ fileType: 'docx', url: 'u', version: 2, key: '42_200' })) })
    const { editor, calls } = editorDouble()

    await hooks(service, editor).onRequestHistoryData!({ data: 2 })

    expect(http.get.mock.calls[0][0]).toContain('editor-version/2/')
    // The token goes as a query param, because the url in the response is fetched
    // by the document server rather than by the page.
    expect(http.get.mock.calls[0][1]).toEqual({ params: { officeToken: 'office-jwt' } })
    expect(calls.setHistoryData[0]).toMatchObject({ version: 2, key: '42_200' })
  })

  it('encodes the space path exactly once', async () => {
    const { service, http } = mount({ get: vi.fn().mockReturnValue(of({})) })
    const { editor } = editorDouble()

    await hooks(service, editor).onRequestHistoryData!({ data: 1 })

    const url = http.get.mock.calls[0][0] as string
    expect(url).not.toContain('%25')
  })

  // Upstream's own error shape (editor.js:244-249): the editor needs the ordinal
  // back to know which row failed.
  it('returns the ordinal alongside the error', async () => {
    const { service } = mount({
      get: vi.fn().mockReturnValue(throwError(() => new HttpErrorResponse({ status: 404, error: { message: 'Version not found' } })))
    })
    const { editor, calls } = editorDouble()

    await hooks(service, editor).onRequestHistoryData!({ data: 7 })

    expect(calls.setHistoryData[0]).toEqual({ error: 'Version not found', version: 7 })
  })
})

describe('EditorHistoryService — onRequestRestore', () => {
  it('reads the ordinal from event.data.version and posts to the restore route', async () => {
    const { service, http } = mount({ post: vi.fn().mockReturnValue(of(HISTORY)) })
    const { editor } = editorDouble()

    await hooks(service, editor).onRequestRestore!({ data: { version: 1 } })

    expect(http.post.mock.calls[0][0]).toContain('editor-restore/1/')
  })

  // The backend answers with the refreshed history precisely so the panel can be
  // updated without a second round trip.
  it('refreshes the panel from the restore response', async () => {
    const { service } = mount({ post: vi.fn().mockReturnValue(of(HISTORY)) })
    const { editor, calls } = editorDouble()

    await hooks(service, editor).onRequestRestore!({ data: { version: 1 } })

    expect((calls.refreshHistory[0] as { currentVersion: number }).currentVersion).toBe(3)
  })

  // NOT cosmetic. A restore drops the cached OnlyOffice document key server-side
  // (invariant 7, #378), but the config in the page still carries the OLD key —
  // so without a re-mount the editor keeps editing pre-restore content and the
  // next save writes it back over the restore.
  it('signals the caller to re-mount the editor after a successful restore', async () => {
    const onRestored = vi.fn()
    const { service } = mount({ post: vi.fn().mockReturnValue(of(HISTORY)) })
    const { editor } = editorDouble()

    await hooks(service, editor, { onRestored }).onRequestRestore!({ data: { version: 1 } })

    expect(onRestored).toHaveBeenCalledOnce()
  })

  // A failed restore did not change the live bytes, so re-mounting would be churn
  // — and worse, it would suggest to the user that something happened.
  it('does NOT signal a re-mount when the restore failed', async () => {
    const onRestored = vi.fn()
    const { service } = mount({ post: vi.fn().mockReturnValue(throwError(() => new HttpErrorResponse({ status: 423 }))) })
    const { editor, calls } = editorDouble()

    await hooks(service, editor, { onRestored }).onRequestRestore!({ data: { version: 1 } })

    expect(onRestored).not.toHaveBeenCalled()
    expect(calls.refreshHistory[0]).toHaveProperty('error')
  })
})

describe('EditorHistoryService — onRequestHistoryClose', () => {
  // The document server exposes NO command to leave history mode — `refreshHistory`
  // and `setHistoryData` are the only two methods it publishes (api.js:924-925) —
  // so the integrator has to reinitialize the editor itself: "When the function is
  // called, the editor must be reinitialized in editing mode" (Docs API,
  // config/events). Upstream does `location.reload(true)`; here the caller
  // re-mounts, for the same reason the restore path does.
  //
  // This handler was inert until #408, on the premise that upstream's reload
  // existed only to clear the stale document key after a restore. It does not —
  // leaving it inert left the panel stuck open and the document read-only.
  it('signals the caller to re-mount the editor', () => {
    const onHistoryClosed = vi.fn()
    const { service } = mount()
    const { editor } = editorDouble()

    hooks(service, editor, { onHistoryClosed }).onRequestHistoryClose!()

    expect(onHistoryClosed).toHaveBeenCalledOnce()
  })

  // The hook must still EXIST when no caller is listening: the document server
  // renders the Close History button off its presence alone
  // (`canHistoryClose = !!events.onRequestHistoryClose`, api.js:408), and it must
  // not throw into the editor's own event dispatch.
  it('does not throw when the caller wired no re-mount', () => {
    const { service } = mount()
    const { editor, calls } = editorDouble()

    expect(() => hooks(service, editor).onRequestHistoryClose!()).not.toThrow()
    expect(calls.refreshHistory).toHaveLength(0)
  })
})

describe('EditorHistoryService — the editor lookup', () => {
  // Resolved on every call rather than captured, because the instance is replaced
  // whenever the component re-mounts — which is exactly what happens right after
  // a restore. A captured reference would address a destroyed editor.
  it('resolves the editor lazily on each event', async () => {
    const { service } = mount({ get: vi.fn().mockReturnValue(of(HISTORY)) })
    const first = editorDouble()
    const second = editorDouble()
    let current = first
    const h = service.hooksFor({
      spacePath: 'files/personal/a.docx',
      officeToken: 't',
      editor: () => current.editor,
      locale: 'en'
    })

    await h.onRequestHistory!()
    current = second
    await h.onRequestHistory!()

    expect(first.calls.refreshHistory).toHaveLength(1)
    expect(second.calls.refreshHistory).toHaveLength(1)
  })

  // The editor can be gone by the time a request resolves — the user navigated
  // away mid-fetch. That must not throw into an unhandled rejection.
  it('tolerates the editor having been destroyed mid-request', async () => {
    const { service } = mount({ get: vi.fn().mockReturnValue(of(HISTORY)) })
    const h = service.hooksFor({ spacePath: 'files/personal/a.docx', officeToken: 't', editor: () => undefined, locale: 'en' })

    await expect(h.onRequestHistory!()).resolves.toBeUndefined()
  })
})
