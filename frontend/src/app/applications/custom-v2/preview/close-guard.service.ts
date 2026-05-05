import { Injectable } from '@angular/core'

// Minimal close-guard used by FileDetailComponent and TextCodeViewComponent.
// The text editor registers a guard when it has unsaved changes; file-detail's
// close() checks it before navigating away. Cleared on editor destroy.
@Injectable({ providedIn: 'root' })
export class CloseGuardService {
  private guard: (() => Promise<boolean>) | null = null

  setCloseGuard(guard: (() => Promise<boolean>) | null): void {
    this.guard = guard
  }

  async canClose(): Promise<boolean> {
    if (!this.guard) return true
    return this.guard()
  }
}
