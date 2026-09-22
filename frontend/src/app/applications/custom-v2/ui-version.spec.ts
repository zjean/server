// Who is allowed to opt a browser into v2.
//
// `uiVersionGuard` sits on the CLASSIC layout route and redirects to /v2 whenever
// localStorage says `ui.version === 'v2'`. That is fine for someone who chose v2 —
// and was a trap while LayoutV2Component wrote the flag in ngOnInit (#502), because
// merely RENDERING v2 set it: opening one pasted /v2/* link opted that browser in
// permanently, and every later classic bookmark, emailed /#/spaces/… deep link and
// the site root bounced away from the UI the user had actually asked for.
//
// The case below is about absence, so it drives the guard on both sides of the
// preference and asserts that mounting the v2 layout leaves storage untouched.
//
// Plain Injector, no TestBed — see screens/files/testing/file-browser-harness.ts.

import { Injector, runInInjectionContext } from '@angular/core'
import { Router } from '@angular/router'
import { afterEach, describe, expect, it } from 'vitest'
import { mount } from './screens/files/testing/file-browser-harness'
import { LayoutV2Component } from './layout/layout-v2.component'
import { getUiVersion, isUiVersionSuspended, setUiVersion, suspendUiVersion } from './ui-version'
import { uiVersionGuard } from './ui-version.guard'

function installStorage(initial: Record<string, string> = {}): Map<string, string> {
  const storage = new Map<string, string>(Object.entries(initial))
  const session = new Map<string, string>()
  ;(globalThis as Record<string, unknown>)['window'] = {
    localStorage: {
      getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k)
    },
    sessionStorage: {
      getItem: (k: string) => (session.has(k) ? session.get(k)! : null),
      setItem: (k: string, v: string) => void session.set(k, v),
      removeItem: (k: string) => void session.delete(k)
    }
  }
  return storage
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)['window']
})

/** Runs the guard with a Router that records what it was asked to parse. */
function runGuard(): { result: unknown; parsed: string[] } {
  const parsed: string[] = []
  const injector = Injector.create({
    providers: [{ provide: Router, useValue: { parseUrl: (url: string) => (parsed.push(url), { url }) } }]
  })
  const result = runInInjectionContext(injector, () => uiVersionGuard(null as never, null as never))
  return { result, parsed }
}

describe('uiVersionGuard', () => {
  it('lets the classic layout load when no preference has been recorded', () => {
    installStorage()
    const { result, parsed } = runGuard()
    expect(result).toBe(true)
    expect(parsed).toEqual([])
  })

  it('redirects to /v2 once the user has explicitly opted in', () => {
    installStorage()
    setUiVersion('v2')
    const { parsed } = runGuard()
    expect(parsed).toEqual(['/v2'])
  })

  // A v2 screen with no v2 equivalent (a shared folder — #429) hands off to classic,
  // and the guard would bounce it straight back. It used to get past by DELETING the
  // preference, which ejected the user from v2 for good over one list click.
  it('stands down for a tab that v2 itself sent to classic, without forgetting the preference', () => {
    const storage = installStorage()
    setUiVersion('v2')
    suspendUiVersion()
    const { result, parsed } = runGuard()
    expect(result).toBe(true)
    expect(parsed).toEqual([])
    expect(storage.get('ui.version')).toBe('v2')
  })

  // Not one-shot: the guard sits on the classic layout route and re-runs on every
  // navigation under it, so a token consumed on first activation would bounce the
  // user out again on their next click inside classic.
  it('stays stood down across repeated activations', () => {
    installStorage()
    setUiVersion('v2')
    suspendUiVersion()
    runGuard()
    expect(runGuard().result).toBe(true)
  })
})

describe('LayoutV2Component', () => {
  // Reaching any /v2 route is what ends an excursion into classic. This is the one
  // preference write the layout may make, and it only ever REMOVES state.
  it('lifts a guard suspension, because being here means the excursion is over', () => {
    installStorage()
    setUiVersion('v2')
    suspendUiVersion()
    mount(LayoutV2Component)
    expect(isUiVersionSuspended()).toBe(false)
    expect(getUiVersion()).toBe('v2')
  })

  it('does not record a v2 preference merely by being rendered', () => {
    const storage = installStorage()
    const res = mount(LayoutV2Component)
    // Whatever lifecycle a future edit adds, it must not be the thing that opts in.
    ;(res.component as unknown as { ngOnInit?: () => void }).ngOnInit?.()
    res.flush()
    expect(storage.has('ui.version')).toBe(false)
    expect(getUiVersion()).toBeNull()
  })
})
