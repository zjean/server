import { HttpHeaders } from '@angular/common/http'
import { inject, Injectable, signal } from '@angular/core'
import { StoreService } from '../../../store/store.service'

export interface TwoFaRequest {
  withPassword: boolean
  withTotp: boolean
}

interface PendingDialog extends TwoFaRequest {
  resolve: (result: HttpHeaders | false) => void
}

@Injectable({ providedIn: 'root' })
export class TwoFaDialogService {
  private readonly store = inject(StoreService)

  readonly pending = signal<PendingDialog | null>(null)

  // Mirrors classic's UserService.auth2FaVerifyDialog.
  // Returns:
  //   - undefined when no 2FA is required (no dialog shown)
  //   - HttpHeaders containing TOTP/password on confirm
  //   - false when the user cancels
  verify(withPassword = false): Promise<HttpHeaders | false | undefined> {
    const user = this.store.user.getValue()
    const withTotp = !!(this.store.server().twoFaEnabled && user?.twoFaEnabled)
    if (!withPassword && !withTotp) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      const existing = this.pending()
      if (existing) existing.resolve(false)
      this.pending.set({ withPassword, withTotp, resolve })
    })
  }

  resolve(result: HttpHeaders | false): void {
    const p = this.pending()
    if (!p) return
    this.pending.set(null)
    p.resolve(result)
  }
}
