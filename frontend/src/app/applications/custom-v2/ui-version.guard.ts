import { inject } from '@angular/core'
import { CanActivateFn, Router } from '@angular/router'
import { V2_PATH } from './v2.constants'
import { getUiVersion } from './ui-version'

// Applied to the classic layout. If the user previously opted into v2,
// route them there instead of loading classic chrome.
export const uiVersionGuard: CanActivateFn = () => {
  if (getUiVersion() === 'v2') {
    return inject(Router).parseUrl(`/${V2_PATH}`)
  }
  return true
}
