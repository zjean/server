import { signal } from '@angular/core'
import type { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'

export type ReadmeSaveOutcome = 'clean' | 'saved' | 'failed'

export interface ReadmeEditTarget {
  path: string
  file: FileProps
}

export interface ReadmeLeaveResult {
  outcome: ReadmeSaveOutcome
  /** The name of the file the outcome refers to, captured before the teardown cleared it. */
  name: string | null
}

// The folder-readme banner's edit session: which file the open editor is editing,
// whether an edit was asked for before the file existed, and the teardown order
// that a folder change forces.
//
// Deliberately a plain class with no injector, no DOM and no HTTP. It holds the
// part of the banner that is load-bearing for correctness (design §5), and the
// component it was extracted from cannot be constructed in the unit-test harness
// at all — that harness is DOM-less on purpose and ProseMirror is not. Everything
// here is verified directly in readme-edit-session.spec.ts.
export class ReadmeEditSession {
  readonly editing = signal(false)

  // The editor's target, CAPTURED when edit mode opens and deliberately not
  // derived from the resolved readme row while editing. This is load-bearing: the
  // folder path can change under us mid-edit (the host screens reload in place),
  // and if the editor's [path]/[file] bindings tracked the row they would swing to
  // the new folder's file — or to null — while the editor still holds unsaved
  // content, making it re-open a different file mid-teardown. Freezing the target
  // means folder navigation cannot disturb the editor; only we tear it down.
  readonly target = signal<ReadmeEditTarget | null>(null)

  // The folder that was current when an edit was requested before the readme row
  // had resolved — e.g. the "Folder description" menu entry creates the file and
  // asks for edit mode before the listing refresh has landed. Storing the path
  // rather than a bare boolean means a navigation in that window discards the
  // intent instead of opening the editor on the next folder's readme.
  private queuedDir: string | null = null

  // Re-entrance guard for leave(): two folder changes in quick succession would
  // otherwise both find editing() still true (the first is awaiting its save) and
  // issue two uploads plus two toasts for one edit.
  private leaving = false

  private lastDir: string | null = null

  open(target: ReadmeEditTarget): void {
    this.queuedDir = null
    this.target.set(target)
    this.editing.set(true)
  }

  // Unmounting the editor is what releases the exclusive lock, so every caller
  // that stops editing goes through here. Clearing the target lets a later Edit
  // re-capture.
  close(): void {
    this.editing.set(false)
    this.target.set(null)
  }

  queue(dir: string): void {
    this.queuedDir = dir
  }

  // True when a queued edit intent belongs to `dir`. Consumes the intent either
  // way — an intent for a folder we have since left must not survive to open the
  // editor on a stranger.
  takeQueued(dir: string): boolean {
    const wanted = this.queuedDir
    this.queuedDir = null
    return wanted !== null && wanted === dir
  }

  // Records the folder the banner is now showing and reports whether that is a
  // move away from a folder it was already showing. False for the first folder
  // (there is nothing to have left) and for a repeat of the same one.
  noteDir(dir: string): boolean {
    const previous = this.lastDir
    this.lastDir = dir
    if (previous === null || previous === dir) return false
    // A queued edit intent from the folder we just left is stale.
    this.queuedDir = null
    return true
  }

  // Folder navigation CANNOT be cancelled: by the time the banner sees the new
  // folder, the host screen has already reloaded. So this path must not prompt — a
  // prompt would offer a "stay" choice it cannot honour. Maintainer's ruling:
  // auto-save the pending edit, then tear down. The frozen target is what makes
  // the await safe; the editor's bindings cannot shift while we do this.
  //
  // Returns null when there was no session to leave. Otherwise returns the save
  // outcome and the file it applied to, and leaves the session closed — the caller
  // owns the user-facing messaging.
  async leave(save: () => Promise<ReadmeSaveOutcome>): Promise<ReadmeLeaveResult | null> {
    if (this.leaving || !this.editing()) return null
    this.leaving = true
    // Captured before the await: close() below clears the target.
    const name = this.target()?.file.name ?? null
    let outcome: ReadmeSaveOutcome
    try {
      outcome = await save()
    } catch {
      // saveNowIfModified is documented never to throw; this is here so a future
      // change to it cannot skip the close() in the finally block.
      outcome = 'failed'
    } finally {
      // Closing is the one thing this path MUST do — it is what releases the
      // exclusive lock. It therefore runs in a finally, before the caller gets a
      // chance to toast or refresh: those run synchronously in the caller's stack,
      // so a throw under either would otherwise leave the editor mounted and the
      // lock held, with `leaving` already cleared so nothing would ever retry.
      this.close()
      this.leaving = false
    }
    return { outcome, name }
  }
}
