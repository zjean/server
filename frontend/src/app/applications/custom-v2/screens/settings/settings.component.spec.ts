// Behavioural pins for the v2 Settings screen.
//
// WHY THIS EXISTS
// ---------------
// Every case here corresponds to a way v2 diverged from the classic account
// screen (issue #421) — the shape of the value sent on the wire, and the
// three-state 2FA verification result. Both are runtime contracts the DTO types
// cannot express, so type-checking does not catch getting them wrong.
//
// WHY NOT TestBed: see `screens/files/testing/file-browser-harness.ts` — the repo
// has no DOM test environment. This builds a plain `Injector` and instantiates
// the component class inside `runInInjectionContext`; only component logic is
// under test, not rendering. `window` is absent unless a case installs a stub,
// which is what exercises the screen's SSR guards.

import { HttpErrorResponse, HttpHeaders } from '@angular/common/http'
import { DestroyRef, Injector, runInInjectionContext } from '@angular/core'
import { Router } from '@angular/router'
import { L10N_LOCALE } from 'angular-l10n'
import type { FileEditorProviders } from '@sync-in-server/backend/src/applications/files/editors/file-editor-providers.interface'
import { Observable, of, throwError } from 'rxjs'
import { afterEach, describe, expect, it } from 'vitest'
import { LayoutService } from '../../../../layout/layout.service'
import { StoreService } from '../../../../store/store.service'
import type { UserType } from '../../../users/interfaces/user.interface'
import { UserService } from '../../../users/user.service'
import { ToastService } from '../../components/toast.service'
import { TwoFaDialogService } from '../../components/two-fa-dialog.service'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { SettingsComponent } from './settings.component'

interface Recorded {
  target: string
  args: unknown[]
}

function makeUser(overrides: Partial<UserType> = {}): UserType {
  return {
    id: 1,
    login: 'sync-in',
    email: 'a@b.c',
    fullName: 'Sync In',
    language: 'en',
    onlineStatus: 0,
    notification: 0,
    storageIndexing: false,
    storageUsage: 0,
    storageQuota: null,
    isUser: true,
    isAdmin: false,
    isGuest: false,
    isLink: false,
    twoFaEnabled: false,
    ...overrides
  } as unknown as UserType
}

interface SetupOptions {
  user?: UserType
  editors?: Partial<FileEditorProviders>
  twoFaResult?: HttpHeaders | false | undefined
  storedEditorPreference?: string | null
  fail?: boolean
  /** Install a `window` stub (with `location.origin` + `localStorage`) before construction. */
  origin?: string
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)['window']
})

/** One test rig: the component plus the doubles it was built with. */
function setup(options: SetupOptions = {}) {
  const calls: Recorded[] = []
  const record = (target: string, ...args: unknown[]) => calls.push({ target, args })
  const respond = <T>(value: T): Observable<T> =>
    options.fail ? throwError(() => new HttpErrorResponse({ status: 500, error: { message: 'boom' } })) : of(value)

  if (options.origin) {
    ;(globalThis as Record<string, unknown>)['window'] = {
      location: { origin: options.origin },
      localStorage: { getItem: () => options.storedEditorPreference ?? null, setItem: () => undefined, removeItem: () => undefined }
    }
  }

  const store = new StoreService()
  store.server.update((s) => ({
    ...s,
    files: { ...s.files, editors: { collabora: false, eurooffice: false, onlyoffice: false, ...options.editors } }
  }))
  store.user.next(options.user ?? makeUser())

  const toasts: { kind: string; message: string }[] = []
  const userService = {
    changePassword: (dto: unknown, headers: HttpHeaders | undefined) => (record('changePassword', dto, headers), respond({})),
    changeNotification: (dto: unknown) => (record('changeNotification', dto), respond({})),
    changeStorageIndexing: (dto: unknown) => (record('changeStorageIndexing', dto), respond({})),
    changeLanguage: (dto: unknown) => (record('changeLanguage', dto), respond({})),
    changeOnlineStatus: (status: number) => record('changeOnlineStatus', status),
    genAvatar: () => respond({}),
    uploadAvatar: () => respond({}),
    getEditorProviderPreference: () => options.storedEditorPreference ?? null,
    setEditorProviderPreference: (p: unknown) => record('setEditorProviderPreference', p)
  }

  const injector = Injector.create({
    providers: [
      { provide: DestroyRef, useValue: { onDestroy: () => () => undefined } },
      { provide: L10N_LOCALE, useValue: { language: 'en' } },
      { provide: StoreService, useValue: store },
      { provide: Router, useValue: {} },
      { provide: V2BreadcrumbService, useValue: { setBreadcrumbs: () => undefined } },
      { provide: UserService, useValue: userService },
      { provide: LayoutService, useValue: { getLanguages: () => ['en', 'nl'], setLanguage: () => Promise.resolve() } },
      {
        provide: ToastService,
        useValue: {
          success: (m: string) => toasts.push({ kind: 'success', message: m }),
          error: (m: string) => toasts.push({ kind: 'error', message: m })
        }
      },
      { provide: TwoFaDialogService, useValue: { verify: () => (record('twoFa.verify'), Promise.resolve(options.twoFaResult)) } }
    ] as never
  })

  // `any`: the screen's members are `protected`, which is a compile-time
  // visibility rule with no runtime meaning. Reaching them is the whole point.
  const component: any = runInInjectionContext(injector, () => new SettingsComponent())
  return { component, calls, toasts, store, of: (t: string) => calls.filter((c) => c.target === t) }
}

describe('SettingsComponent — password change and 2FA verification', () => {
  const fillPassword = (c: any) => {
    c.oldPassword.set('old-password')
    c.newPassword.set('new-password')
    c.confirmPassword.set('new-password')
  }

  it('abandons the change when the user closes the verification dialog', async () => {
    const rig = setup({ twoFaResult: false })
    fillPassword(rig.component)
    await rig.component.savePassword()
    expect(rig.of('twoFa.verify')).toHaveLength(1)
    expect(rig.of('changePassword')).toHaveLength(0)
    // The form must stay filled and the button re-enabled, otherwise cancelling
    // strands the screen in a permanently-saving state.
    expect(rig.component.savingPassword()).toBe(false)
    expect(rig.component.oldPassword()).toBe('old-password')
  })

  it('sends NO headers when no verification is needed (the `undefined` state)', async () => {
    // The bug this pins: `if (!headers) return` would read `undefined` as a
    // cancellation and break password change for every user without 2FA.
    const rig = setup({ twoFaResult: undefined })
    fillPassword(rig.component)
    await rig.component.savePassword()
    const call = rig.of('changePassword')[0]
    expect(call.args[0]).toEqual({ oldPassword: 'old-password', newPassword: 'new-password' })
    expect(call.args[1]).toBeUndefined()
    expect(rig.component.oldPassword()).toBe('')
  })

  it('passes the verification headers straight through when 2FA is enabled', async () => {
    // The other half of the bug: v2 built `new HttpHeaders()` and sent an empty
    // header set, so the server rejected every 2FA user's password change.
    const headers = new HttpHeaders({ 'x-2fa-code': '123456' })
    const rig = setup({ twoFaResult: headers })
    fillPassword(rig.component)
    await rig.component.savePassword()
    expect(rig.of('changePassword')[0].args[1]).toBe(headers)
  })

  it('does not open the dialog at all when the form is incomplete', async () => {
    const rig = setup({ twoFaResult: undefined })
    rig.component.oldPassword.set('old-password')
    await rig.component.savePassword()
    expect(rig.of('twoFa.verify')).toHaveLength(0)
  })
})

describe('SettingsComponent — notification preference', () => {
  it('sends a NUMBER, not a boolean', () => {
    const rig = setup()
    rig.component.updateNotification(1)
    expect(rig.of('changeNotification')[0].args[0]).toEqual({ notification: 1 })
    expect(rig.store.user.getValue().notification).toBe(1)
  })

  it('reverts the control when the request fails', () => {
    const rig = setup({ user: makeUser({ notification: 1 } as Partial<UserType>), fail: true })
    rig.component.ngOnInit()
    rig.component.updateNotification(0)
    expect(rig.component.notification()).toBe(1)
    expect(rig.toasts.at(-1)?.kind).toBe('error')
  })
})

describe('SettingsComponent — full-text search preference', () => {
  it('sends the storageIndexing DTO and reports it in full-text-search wording', () => {
    const rig = setup()
    rig.component.updateStorageIndexing(true)
    expect(rig.of('changeStorageIndexing')[0].args[0]).toEqual({ storageIndexing: true })
    expect(rig.store.user.getValue().storageIndexing).toBe(true)
    expect(rig.toasts.at(-1)?.message).toBe('Full-text search preference updated')
  })

  it('reverts the toggle when the request fails', () => {
    const rig = setup({ fail: true })
    rig.component.updateStorageIndexing(true)
    expect(rig.component.storageIndexing()).toBe(false)
  })
})

describe('SettingsComponent — editor preference', () => {
  it('offers no choice unless Collabora and an office editor are both configured', () => {
    expect(setup({ editors: { collabora: true } }).component.showEditorPreference()).toBe(false)
    expect(setup({ editors: { onlyoffice: true } }).component.showEditorPreference()).toBe(false)
    expect(setup({ editors: { collabora: true, onlyoffice: true } }).component.showEditorPreference()).toBe(true)
    expect(setup({ editors: { collabora: true, eurooffice: true } }).component.showEditorPreference()).toBe(true)
  })

  it('labels the office slot per the configured provider', () => {
    expect(setup({ editors: { collabora: true, onlyoffice: true } }).component.editorOptions()).toEqual([
      { label: 'Collabora', value: 'collabora' },
      { label: 'OnlyOffice', value: 'onlyoffice' }
    ])
    expect(setup({ editors: { collabora: true, eurooffice: true } }).component.editorOptions()).toEqual([
      { label: 'Collabora', value: 'collabora' },
      { label: 'Euro-Office', value: 'eurooffice' }
    ])
  })

  it('writes the preference to local storage — there is no endpoint', () => {
    const rig = setup({ editors: { collabora: true, onlyoffice: true } })
    rig.component.updateEditorPreference('collabora')
    expect(rig.of('setEditorProviderPreference')[0].args[0]).toBe('collabora')
    rig.component.updateEditorPreference(null)
    expect(rig.of('setEditorProviderPreference')[1].args[0]).toBeNull()
  })

  it('falls back to "Ask Me" when the stored value names an editor this server does not offer', () => {
    // localStorage outlives a server reconfiguration, so the stored value has to
    // be validated against the current options — classic does the same.
    const rig = setup({ origin: 'http://x', editors: { collabora: true, eurooffice: true }, storedEditorPreference: 'onlyoffice' })
    rig.component.ngOnInit()
    expect(rig.component.editorPreference()).toBeNull()
  })

  it('keeps a stored value that is still on offer', () => {
    const rig = setup({ origin: 'http://x', editors: { collabora: true, onlyoffice: true }, storedEditorPreference: 'onlyoffice' })
    rig.component.ngOnInit()
    expect(rig.component.editorPreference()).toBe('onlyoffice')
  })

  it('reads nothing without a browser, rather than throwing on localStorage', () => {
    const rig = setup({ editors: { collabora: true, onlyoffice: true }, storedEditorPreference: 'onlyoffice' })
    rig.component.ngOnInit()
    expect(rig.component.editorPreference()).toBeNull()
  })
})

describe('SettingsComponent — WebDAV address', () => {
  it('derives the URL from the page origin and the backend WebDAV base path', () => {
    expect(setup({ origin: 'https://files.example.com' }).component.webdavUrl).toBe('https://files.example.com/webdav')
  })

  it('is empty rather than a throw when there is no window', () => {
    expect(setup().component.webdavUrl).toBe('')
  })
})
