import { inject } from '@angular/core'
import { CanActivateFn, Router } from '@angular/router'
import { V2_PATH } from './v2.constants'
import { getUiVersion, isUiVersionSuspended } from './ui-version'

// Applied to the classic layout. If the user previously opted into v2,
// route them there instead of loading classic chrome.
//
// Unless v2 itself sent the user here: a v2 screen with no v2 equivalent (a shared
// folder, a placeholder) hands off to classic, and the hand-off suspends the guard for
// the tab rather than deleting the preference. See `suspendUiVersion()`.
export const uiVersionGuard: CanActivateFn = () => {
  if (getUiVersion() === 'v2' && !isUiVersionSuspended()) {
    return inject(Router).parseUrl(`/${V2_PATH}`)
  }
  return true
}
