import { Injectable, signal } from '@angular/core'
import type { FileSpace } from '@sync-in-server/backend/src/applications/files/interfaces/file-space.interface'

export interface ShareDialogInput {
  // Create flow: file to share + path.
  file?: Pick<FileSpace, 'id' | 'name' | 'isDir' | 'mime' | 'space'>
  relativePath?: string
  // Create flow: owner id (current user id for personal files; null when the file lives in a space the user doesn't own).
  ownerId?: number | null
  // Edit flow: existing share id (we'll fetch the full share inside the dialog).
  existingShareId?: number
}

export interface ShareDialogResult {
  shareId: number
  // True when the user revoked the share during this dialog session.
  revoked?: boolean
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
