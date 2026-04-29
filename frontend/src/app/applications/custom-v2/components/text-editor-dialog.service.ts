import { Injectable, signal } from '@angular/core'
import type { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'

export interface TextEditorDialogInput {
  // Backend-side path (e.g. 'files/personal/notes/foo.md') used to build dataUrl + upload route.
  fullPath: string
  // FileProps as it came from /api/spaces/browse — name + mime + size + lock + id.
  file: FileProps
  // Whether the current user has MODIFY on this file. Read-only viewers still get to read.
  isWriteable: boolean
}

@Injectable({ providedIn: 'root' })
export class TextEditorDialogService {
  // Component reads this; null means dialog is closed.
  readonly pending = signal<TextEditorDialogInput | null>(null)

  open(input: TextEditorDialogInput): void {
    this.pending.set({ ...input })
  }

  close(): void {
    this.pending.set(null)
  }
}
