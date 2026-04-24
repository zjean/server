import { Injectable, signal } from '@angular/core'
import type { FileSpace } from '@sync-in-server/backend/src/applications/files/interfaces/file-space.interface'
import type { ShareLinkModel } from '../../links/models/share-link.model'

export interface LinkDialogInput {
  // Create flow: supply the file the link should point at (includes id + name + mime + isDir + space context).
  file?: Pick<FileSpace, 'id' | 'name' | 'isDir' | 'mime' | 'space'>
  // Create flow: relative path (after stripping `files/<space-alias>/`) — what CreateOrUpdateShareDto expects in file.path.
  relativePath?: string
  // Create flow: owner id (current user id for personal files; null when the file lives in a space the user doesn't own).
  ownerId?: number | null
  // Edit flow: supply the existing share-link row.
  existing?: ShareLinkModel
}

export interface LinkDialogResult {
  // Absolute URL (document.location.origin based).
  url: string
  // Share id — what the backend persists.
  shareId: number
  // The settings that were just saved. Useful for optimistic list updates.
  password: string | null
  expiresAt: Date | null
  requireAuth: boolean
  isActive: boolean
  // True when the user revoked the link during this dialog session.
  revoked?: boolean
}

interface PendingDialog extends LinkDialogInput {
  resolve: (value: LinkDialogResult | null) => void
}

@Injectable({ providedIn: 'root' })
export class LinkDialogService {
  readonly pending = signal<PendingDialog | null>(null)
  // Result latched by the dialog on successful submit or revoke; released on close.
  private latched: LinkDialogResult | null = null

  open(opts: LinkDialogInput): Promise<LinkDialogResult | null> {
    return new Promise<LinkDialogResult | null>((resolve) => {
      const existing = this.pending()
      if (existing) existing.resolve(null)
      this.latched = null
      this.pending.set({ ...opts, resolve })
    })
  }

  latch(result: LinkDialogResult): void {
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
