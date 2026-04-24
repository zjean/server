import { Injectable, signal } from '@angular/core'

export interface PromptDialogOptions {
  title: string
  message?: string
  placeholder?: string
  initialValue?: string
  submitLabel: string
  cancelLabel?: string
  selectionRange?: 'all' | 'stem'
  validate?: (value: string) => string | null
}

interface PendingPrompt extends PromptDialogOptions {
  resolve: (value: string | null) => void
}

@Injectable({ providedIn: 'root' })
export class PromptDialogService {
  readonly pending = signal<PendingPrompt | null>(null)

  open(opts: PromptDialogOptions): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const existing = this.pending()
      if (existing) existing.resolve(null)
      this.pending.set({ ...opts, resolve })
    })
  }

  resolve(value: string | null): void {
    const p = this.pending()
    if (!p) return
    this.pending.set(null)
    p.resolve(value)
  }
}
