import { Injectable, signal } from '@angular/core'

export interface TreePickerOptions {
  title: string
  submitLabel: string
  allowSpaces?: boolean
  allowShares?: boolean
  disabledPath?: string
}

export interface TreePickerResult {
  path: string
  name: string
  mime: string
}

interface PendingPicker extends TreePickerOptions {
  resolve: (result: TreePickerResult | null) => void
}

@Injectable({ providedIn: 'root' })
export class TreePickerService {
  readonly pending = signal<PendingPicker | null>(null)

  open(opts: TreePickerOptions): Promise<TreePickerResult | null> {
    return new Promise<TreePickerResult | null>((resolve) => {
      const existing = this.pending()
      if (existing) existing.resolve(null)
      this.pending.set({ ...opts, resolve })
    })
  }

  resolve(result: TreePickerResult | null): void {
    const p = this.pending()
    if (!p) return
    this.pending.set(null)
    p.resolve(result)
  }
}
