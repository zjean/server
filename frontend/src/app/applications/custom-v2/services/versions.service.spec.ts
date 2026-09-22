// The availability latch, and nothing else.
//
// `probe()` is called on EVERY non-directory selection in the file detail panel
// and on every editor open, and it is a real HTTP request until `availability`
// settles. So what does and does not settle it is the difference between one
// request per session and one per file click — which is why this narrow behaviour
// gets a spec of its own while the rest of the service is plain url assembly.
//
// Two different terminal answers, deliberately not treated alike: the feature
// being off is global and latches; a 403 is not necessarily global and only
// suppresses the root it came from.
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
  // before any path is resolved. That really is per-principal and session-long —
  // but it is NOT the only 403 these calls return: SpaceGuard throws 403 for a
  // disabled space and for an insufficient grant, both per-SPACE and both
  // reachable by an ordinary USER. So a 403 suppresses the ROOT it came from
  // rather than latching availability, which would have hidden the panel in every
  // other space for the rest of the session.
  it('a 403 suppresses further probes of that root without latching globally', () => {
    const { service, http } = mount(failing(403, 'Version history is not available for this account'))

    service.probe(PATH)
    // NOT 'unavailable' — every consumer tests `=== 'available'`, so the panel is
    // hidden either way, and 'unknown' keeps the other spaces answerable.
    expect(service.availability()).toBe('unknown')

    // The assertion that actually matters: ten more selections, still one request.
    for (let i = 0; i < 10; i++) service.probe(`files/personal/file-${i}.md`)
    expect(http.get).toHaveBeenCalledTimes(1)
  })

  // The regression this replaced: one refused space must not answer for the next.
  it('a 403 in one space does not silence the probe in another', () => {
    const { service, http } = mount(failing(403, 'Space is disabled'))

    service.probe('files/disabled-space/doc.md')
    expect(http.get).toHaveBeenCalledTimes(1)

    service.probe('files/personal/report.md')
    expect(http.get).toHaveBeenCalledTimes(2)
    expect(service.availability()).toBe('unknown')
  })

  // The 403 branch reads no message, so it must not depend on one: the gate's
  // wording is a backend string this service deliberately does not import.
  it('suppresses on a 403 whatever body it carries', () => {
    const { service, http } = mount(failing(403))
    service.probe(PATH)
    service.probe('files/personal/other.md')
    expect(http.get).toHaveBeenCalledTimes(1)
    expect(service.availability()).toBe('unknown')
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
