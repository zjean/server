import { Injectable, signal } from '@angular/core'
import type { FileSpace } from '@sync-in-server/backend/src/applications/files/interfaces/file-space.interface'

export interface ShareDialogFileCtx {
  file: Pick<FileSpace, 'id' | 'name' | 'isDir' | 'mime' | 'space'>
  relativePath: string
  // Current user id for files the user owns; null otherwise (e.g. space files).
  ownerId: number | null
}

export interface ShareDialogInput {
  // Create flow, single file (shorthand for files: [{...}]).
  file?: Pick<FileSpace, 'id' | 'name' | 'isDir' | 'mime' | 'space'>
  relativePath?: string
  ownerId?: number | null
  // Create flow, multi: share the same member set across N files. One
  // createShare call per entry on submit; per-file failures are collected
  // and surfaced as a summary toast.
  files?: ShareDialogFileCtx[]
  // Edit flow: existing share id (we'll fetch the full share inside the dialog).
  existingShareId?: number
}

export interface ShareDialogResult {
  shareId: number
  // True when the user revoked the share during this dialog session.
  revoked?: boolean
  // Present only for multi-file create flows. shareId above is the first
  // successfully created share id (arbitrary); these two counters describe
  // the whole batch.
  multi?: { created: number; failed: number }
}

interface PendingDialog extends ShareDialogInput {
  resolve: (value: ShareDialogResult | null) => void
}

@Injectable({ providedIn: 'root' })
export class ShareDialogService {
  readonly pending = signal<PendingDialog | null>(null)
  private latched: ShareDialogResult | null = null

  open(opts: ShareDialogInput): Promise<ShareDialogResult | null> {
    return new Promise<ShareDialogResult | null>((resolve) => {
      const existing = this.pending()
      if (existing) existing.resolve(null)
      this.latched = null
      this.pending.set({ ...opts, resolve })
    })
  }

  latch(result: ShareDialogResult): void {
    this.latched = result
  }

  close(): void {
    const p = this.pending()
    if (!p) return
    const result = this.latched
    this.latched = null
    this.pending.set(null)
    p.resolve(result)
  }
}
