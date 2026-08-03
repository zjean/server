import { Injectable, signal } from '@angular/core'
import type { FileLockProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'

/**
 * What the user chose in the unlock dialog.
 *
 * `unlock` releases the lock outright; `request` notifies the current holder and
 * leaves the lock in place. `null` (a dismissed dialog) is the third outcome and
 * is expressed by the resolved value, not by a member here.
 *
 * The dialog does NOT perform either call. Classic's FilesLockDialogComponent
 * does — it injects FilesService and unlocks from inside the modal — but v2's
 * dialog services are pure UI: they resolve a Promise and the caller acts. That
 * keeps the `forceAsFileOwner` decision (see LockDialogOptions.isFileOwner) in
 * the one place that derived it, and it makes the flow assertable from the
 * file-browser harness, which stubs services rather than rendering components.
 */
export type LockDialogChoice = 'unlock' | 'request'

export interface LockDialogOptions {
  /** File name, shown in the dialog header. */
  fileName: string
  /** The lock as the browse response reported it. */
  lock: FileLockProps
  /**
   * Whether the current user owns the FILE (as opposed to the lock).
   *
   * Derived by the caller, because half of classic's expression is screen state
   * rather than row state: `spacesBrowserService.inPersonalSpace ||
   * file.root?.owner?.login === userLogin` (files-lock-dialog.component.ts:37).
   * In a personal space you are always the file owner. The dialog cannot
   * reconstruct that from the row alone.
   *
   * It is also what the caller passes as the `forceAsFileOwner` query param on
   * the unlock request (files.service.ts:239) — classic passes exactly this
   * flag, including when the user happens to be the lock owner too.
   */
  isFileOwner: boolean
}

interface PendingLockDialog extends LockDialogOptions {
  resolve: (choice: LockDialogChoice | null) => void
}

/**
 * v2's unlock dialog. Parity target: classic's `FilesLockDialogComponent`,
 * reached from the clickable lock badge on a locked row
 * (spaces-browser.component.html:252 / :427).
 *
 * Unlock-only, deliberately: classic has no "lock this file" gesture anywhere.
 * `filesService.lock()` is called by editor sessions only — including v2's own
 * markdown and text/code editors — so the user-facing surface is releasing a
 * lock, never taking one.
 */
@Injectable({ providedIn: 'root' })
export class LockDialogService {
  readonly pending = signal<PendingLockDialog | null>(null)

  open(opts: LockDialogOptions): Promise<LockDialogChoice | null> {
    return new Promise<LockDialogChoice | null>((resolve) => {
      const existing = this.pending()
      if (existing) existing.resolve(null)
      this.pending.set({ ...opts, resolve })
    })
  }

  resolve(choice: LockDialogChoice | null): void {
    const p = this.pending()
    if (!p) return
    this.pending.set(null)
    p.resolve(choice)
  }
}
