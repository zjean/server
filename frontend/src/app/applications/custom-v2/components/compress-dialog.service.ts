import { Injectable, signal } from '@angular/core'
import { TAR_EXTENSION, ZIP_EXTENSION } from '@sync-in-server/backend/src/applications/files/constants/compress'

export type CompressExtension = typeof TAR_EXTENSION | typeof ZIP_EXTENSION

export interface CompressDialogOptions {
  title: string
  message?: string
  placeholder?: string
  initialValue?: string
  submitLabel: string
  cancelLabel?: string
  // Shown in the header (e.g. "3 items"); the caller already knows the count.
  fileCount?: number
  validate?: (value: string) => string | null
}

export interface CompressDialogResult {
  name: string
  extension: CompressExtension
  compression: boolean
}

interface PendingCompress extends CompressDialogOptions {
  resolve: (value: CompressDialogResult | null) => void
}

// Mirrors PromptDialogService: a single pending request held in a signal, the
// host component renders from it and resolves the Promise. Unlike the prompt
// dialog, this returns the full archive choice (name + tar/zip + compression)
// so callers build the CompressFileDto without a second round-trip.
@Injectable({ providedIn: 'root' })
export class CompressDialogService {
  readonly pending = signal<PendingCompress | null>(null)

  open(opts: CompressDialogOptions): Promise<CompressDialogResult | null> {
    return new Promise<CompressDialogResult | null>((resolve) => {
      const existing = this.pending()
      if (existing) existing.resolve(null)
      this.pending.set({ ...opts, resolve })
    })
  }

  resolve(value: CompressDialogResult | null): void {
    const p = this.pending()
    if (!p) return
    this.pending.set(null)
    p.resolve(value)
  }
}
