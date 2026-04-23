import { Injectable, signal } from '@angular/core'

export interface ConfirmDialogOptions {
  title: string
  message: string
  confirmLabel: string
  cancelLabel?: string
  kind?: 'default' | 'danger'
  messageParams?: Record<string, string | number>
}

interface PendingDialog extends ConfirmDialogOptions {
  resolve: (confirmed: boolean) => void
}

@Injectable({ providedIn: 'root' })
export class ConfirmDialogService {
  readonly pending = signal<PendingDialog | null>(null)

  open(opts: ConfirmDialogOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const existing = this.pending()
      if (existing) existing.resolve(false)
      this.pending.set({ ...opts, resolve })
    })
  }

  resolve(confirmed: boolean): void {
    const p = this.pending()
    if (!p) return
    this.pending.set(null)
    p.resolve(confirmed)
  }
}
