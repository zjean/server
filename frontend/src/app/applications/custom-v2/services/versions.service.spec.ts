// The availability latch, and nothing else.
//
// `probe()` is called on EVERY non-directory selection in the file detail panel
// and on every editor open, and it is a real HTTP request until `availability`
// settles. So what does and does not latch is the difference between one request
// per session and one per file click — which is why this narrow behaviour gets a
// spec of its own while the rest of the service is plain url assembly.
//
// Same no-TestBed approach as the rest of the v2 specs: a plain Injector, no
// platform. See screens/files/testing/file-browser-harness.ts for the rationale.

import { describe, expect, it, vi } from 'vitest'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { Injector, runInInjectionContext } from '@angular/core'
import { of, throwError } from 'rxjs'
import { VERSIONS_DISABLED_MESSAGE } from '@sync-in-server/backend/src/applications/custom-versioning/constants/versioning'
import { VersionsService } from './versions.service'

const PATH = 'files/personal/docs/report.md'

function mount(get: ReturnType<typeof vi.fn>) {
  const http = { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() }
  const injector = Injector.create({ providers: [{ provide: HttpClient, useValue: http }] as never })
  const service = runInInjectionContext(injector, () => new VersionsService())
  return { service, http }
}

const failing = (status: number, message?: string) =>
  vi.fn(() => throwError(() => new HttpErrorResponse({ status, error: message === undefined ? null : { message } })))

describe('VersionsService availability', () => {
  it('starts unknown and settles to available on a success', () => {
    const { service, http } = mount(vi.fn(() => of({ used: 0, count: 0, ceiling: null })))
    expect(service.availability()).toBe('unknown')

    service.probe(PATH)
    expect(service.availability()).toBe('available')

    // Settled, so a second probe costs nothing.
    service.probe(PATH)
    expect(http.get).toHaveBeenCalledTimes(1)
  })

  it('latches unavailable on the feature-off 404', () => {
    const { service } = mount(failing(404, VERSIONS_DISABLED_MESSAGE))
    service.probe(PATH)
    expect(service.availability()).toBe('unavailable')
  })

  // #492. The role gate refuses a guest or link principal EVERY versions route,
  // before any path is resolved — a per-principal, session-long answer, exactly
  // as terminal as the feature being off. Left unlatched it is not a rendering
  // bug (the panel is hidden either way) but an unbounded one: `probe()` only
  // no-ops once availability is settled, so the next file click asks again.
  it('latches unavailable on a 403 from the role gate, so the probe stops re-firing', () => {
    const { service, http } = mount(failing(403, 'Version history is not available for this account'))

    service.probe(PATH)
    expect(service.availability()).toBe('unavailable')

    // The assertion that actually matters: ten more selections, still one request.
    for (let i = 0; i < 10; i++) service.probe(`files/personal/file-${i}.md`)
    expect(http.get).toHaveBeenCalledTimes(1)
  })

  // No message check on the 403 branch, so it must not depend on one: the gate's
  // wording is a backend string this service deliberately does not import.
  it('latches on a 403 whatever body it carries', () => {
    const { service } = mount(failing(403))
    service.probe(PATH)
    expect(service.availability()).toBe('unavailable')
  })

  // The other half of the rule: a per-FILE failure must never disable the panel
  // for the whole session. 404 'Space not found' is what SpaceGuard answers for a
  // path it cannot resolve, and 423/500 are transient.
  it.each([
    { status: 404, message: 'Space not found' },
    { status: 423, message: 'Locked' },
    { status: 500, message: 'Internal server error' }
  ])('leaves availability unknown for a per-file $status', ({ status, message }) => {
    const { service, http } = mount(failing(status, message))
    service.probe(PATH)
    expect(service.availability()).toBe('unknown')

    // Still unknown, so the next file is still allowed to ask.
    service.probe(PATH)
    expect(http.get).toHaveBeenCalledTimes(2)
  })

  it('does not latch on a non-HTTP error', () => {
    const { service } = mount(vi.fn(() => throwError(() => new Error('offline'))))
    service.probe(PATH)
    expect(service.availability()).toBe('unknown')
  })
})
