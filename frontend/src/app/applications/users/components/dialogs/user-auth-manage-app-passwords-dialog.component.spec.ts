// Which scopes the classic app-password dialog offers.
//
// The dropdown used to be `Object.values(AUTH_SCOPE)`, so adding the fork's
// MOBILE_NC scope silently put a third, untranslated "Mobile_nc" option in front of
// every user (#504). Credentials for that scope are minted by the custom-mobile-compat
// pairing flow and pruned to the newest five, so one created by hand here disappears
// the next time a phone pairs.
//
// The case is about a list the fork must keep CLOSED against an enum it keeps
// extending, which no type can express — hence a test.
//
// Plain Injector, no TestBed — same shape as user-account.component.spec.ts.

import { Injector, runInInjectionContext } from '@angular/core'
import { UntypedFormBuilder } from '@angular/forms'
import { AUTH_SCOPE } from '@sync-in-server/backend/src/authentication/constants/scope'
import { L10N_LOCALE } from 'angular-l10n'
import { ClipboardService } from 'ngx-clipboard'
import { describe, expect, it } from 'vitest'
import { LayoutService } from '../../../../layout/layout.service'
import { UserService } from '../../user.service'
import { UserAuthManageAppPasswordsDialogComponent } from './user-auth-manage-app-passwords-dialog.component'

function build(): { availableApps: AUTH_SCOPE[] } {
  const injector = Injector.create({
    providers: [
      { provide: L10N_LOCALE, useValue: { language: 'en' } },
      { provide: UntypedFormBuilder, useValue: new UntypedFormBuilder() },
      { provide: LayoutService, useValue: {} },
      { provide: UserService, useValue: {} },
      { provide: ClipboardService, useValue: {} }
    ]
  })
  const component = runInInjectionContext(injector, () => new UserAuthManageAppPasswordsDialogComponent())
  return component as unknown as { availableApps: AUTH_SCOPE[] }
}

describe('classic app-password dialog', () => {
  it('offers exactly the two scopes a user can mint by hand', () => {
    expect(build().availableApps).toEqual([AUTH_SCOPE.WEBDAV, AUTH_SCOPE.CLIENT])
  })

  it('does not offer the Nextcloud mobile scope, whatever the enum grows to', () => {
    expect(build().availableApps).not.toContain(AUTH_SCOPE.MOBILE_NC)
  })
})
