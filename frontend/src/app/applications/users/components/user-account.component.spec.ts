// Pins that the classic account screen SUBSCRIBES to UserService's avatar methods.
//
// This is a regression guard for a defect that shipped and survived review twice:
// the fork changed UserService.genAvatar() / uploadAvatar() to return a COLD
// Observable so custom-v2's settings screen could own its toasts
// (settings.component.ts:157,164), and left these two callers dropping the return
// value. A cold Observable with no subscriber never runs, so no HTTP request was
// ever sent — the classic "Generate" button and the avatar file input silently did
// nothing. No error, no failing test, and no TYPE error either, because an unused
// return value is perfectly legal TypeScript.
//
// So the assertion here is deliberately about SUBSCRIPTION, not about the request:
// each stub returns an Observable that counts its subscribers, which is the only
// thing that distinguishes the bug from the fix.
//
// No TestBed: the component uses inject() for four services, so a plain Injector is
// enough. Same shape as layout-v2.service.spec.ts and favorites.service.spec.ts.

import { Injector, runInInjectionContext } from '@angular/core'
import { L10N_LOCALE } from 'angular-l10n'
import { BehaviorSubject, Observable, throwError } from 'rxjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LayoutService } from '../../../layout/layout.service'
import { StoreService } from '../../../store/store.service'
import { ClipboardService } from 'ngx-clipboard'
import { UserService } from '../user.service'
import { UserAccountComponent } from './user-account.component'

// Counts subscribers so a "nobody subscribed" regression is visible.
function counted(): { obs: Observable<void>; subscribes: () => number } {
  let n = 0
  return {
    obs: new Observable<void>((sub) => {
      n++
      sub.next()
      sub.complete()
    }),
    subscribes: () => n
  }
}

// jsdom is not in this suite's environment (`environment: node`), and the component
// builds its WebDAV URL from window.location.origin in a field initializer.
function stubWindow(): void {
  ;(globalThis as unknown as { window: unknown }).window = { location: { origin: 'http://localhost:8080' } }
}

function build(over: { genAvatar?: Observable<void>; uploadAvatar?: Observable<void> } = {}) {
  stubWindow()
  const notifications: unknown[][] = []
  const layout = {
    setBreadcrumbIcon: vi.fn(),
    setBreadcrumbNav: vi.fn(),
    getLanguages: vi.fn(() => []),
    sendNotification: (...args: unknown[]) => void notifications.push(args)
  } as unknown as LayoutService

  const store = {
    user: new BehaviorSubject({ language: 'en' }),
    userAvatarUrl: new BehaviorSubject('/api/users/avatar/me?random=1'),
    // Editor preference is read in the constructor; false keeps that branch out.
    server: () => ({ files: { editors: { collabora: false, onlyoffice: false, eurooffice: false } } })
  } as unknown as StoreService

  const userService = {
    genAvatar: vi.fn(() => over.genAvatar ?? counted().obs),
    uploadAvatar: vi.fn(() => over.uploadAvatar ?? counted().obs),
    getEditorProviderPreference: vi.fn(() => null)
  } as unknown as UserService

  const injector = Injector.create({
    providers: [
      { provide: LayoutService, useValue: layout },
      { provide: StoreService, useValue: store },
      { provide: UserService, useValue: userService },
      { provide: ClipboardService, useValue: {} },
      { provide: L10N_LOCALE, useValue: { language: 'en' } }
    ]
  })
  const component = runInInjectionContext(injector, () => new UserAccountComponent())
  return { component: component as any, userService: userService as any, notifications }
}

describe('UserAccountComponent — avatar actions', () => {
  let consoleError: typeof console.error

  beforeEach(() => {
    consoleError = console.error
    console.error = () => undefined
  })

  afterEach(() => {
    console.error = consoleError
  })

  it('genAvatar SUBSCRIBES — a cold observable that is never subscribed sends no request', () => {
    const gen = counted()
    const { component, userService } = build({ genAvatar: gen.obs })

    component.genAvatar()

    expect(userService.genAvatar).toHaveBeenCalledTimes(1)
    // The assertion that separates the bug from the fix.
    expect(gen.subscribes()).toBe(1)
  })

  it('uploadAvatar SUBSCRIBES, and passes the selected file through', () => {
    const upload = counted()
    const { component, userService } = build({ uploadAvatar: upload.obs })
    const file = { name: 'me.png' }

    component.uploadAvatar({ target: { files: [file] } })

    expect(userService.uploadAvatar).toHaveBeenCalledWith(file)
    expect(upload.subscribes()).toBe(1)
  })

  it('notifies on a failed generate rather than failing silently', () => {
    const { component, notifications } = build({ genAvatar: throwError(() => ({ status: 500 })) })

    component.genAvatar()

    expect(notifications).toHaveLength(1)
    expect(notifications[0].slice(0, 3)).toEqual(['error', 'Configuration', 'Avatar'])
  })

  it('notifies on a failed upload rather than failing silently', () => {
    const { component, notifications } = build({ uploadAvatar: throwError(() => ({ status: 413 })) })

    component.uploadAvatar({ target: { files: [{ name: 'big.png' }] } })

    expect(notifications).toHaveLength(1)
    expect(notifications[0].slice(0, 3)).toEqual(['error', 'Configuration', 'Avatar'])
  })
})
