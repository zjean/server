import { computed, Injectable, signal } from '@angular/core'
import { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'

// Cross-screen drag state for "move file/folder by dragging it onto a folder
// row or a breadcrumb segment". Personal and space-files screens both push
// their selection here on dragstart; folder rows + breadcrumb segments read
// from here on dragover/drop.
//
// Kept as a tiny signal-store rather than a directive so the *page-breadcrumb*
// component (a sibling, not a child) can also subscribe and act as a drop
// target without prop-drilling.

export interface DragPayload {
  // The files being dragged. If the dragstart originated from a row that was
  // already part of the selection, this is the whole selection; otherwise it's
  // just that single row. Held as FileProps so consumers can re-derive
  // anything they need (id, path-from-name, isDir, ...).
  files: FileProps[]
  // Absolute Sync-in path of the directory that holds these files (e.g.
  // 'files/personal/Photos'). Used to short-circuit a drop onto the same
  // directory (no-op) and to keep the breadcrumb-drop logic from moving a
  // file to where it already is.
  sourceDir: string
  // Same as files.map(f => f.id), pre-computed so canDropOn's "target is one
  // of the dragged files" check is O(1).
  draggedIds: ReadonlySet<number>
}

// Screen-side handler invoked when a drop happens at the service layer
// (e.g. via a shared component like the breadcrumb). Screens register one of
// these in ngOnInit so the service knows how to actually execute the move
// for the current space — converting FileProps to FileModel stubs, calling
// FilesService.copyMove, firing toasts, clearing selection. Returns an
// unsubscribe.
export type DropHandler = (targetPath: string, files: FileProps[]) => void

@Injectable({ providedIn: 'root' })
export class V2DragService {
  private readonly _payload = signal<DragPayload | null>(null)
  readonly payload = this._payload.asReadonly()
  private dropHandler: DropHandler | null = null

  // True while a drag is in flight. Components hide non-drop UI affordances
  // and lift up drop-target styling while this is true.
  readonly active = computed(() => this._payload() !== null)

  // Begin a drag. Caller is responsible for stamping native dataTransfer too
  // (the HTML5 API requires *something* on dataTransfer for the drag to be
  // valid in some browsers — see consumers).
  start(files: FileProps[], sourceDir: string): void {
    if (files.length === 0) return
    this._payload.set({
      files,
      sourceDir,
      draggedIds: new Set(files.map((f) => f.id))
    })
  }

  // End the drag — call from both `dragend` (drag cancelled or completed
  // without a drop) and `drop` (after the drop handler has run). Idempotent.
  end(): void {
    this._payload.set(null)
  }

  // Register the screen's drop handler. The returned function unregisters
  // it; call from ngOnDestroy. The "if still the same handler" check guards
  // against a stale unregister stomping on a freshly-mounted screen during a
  // race (Angular's destroy/construct ordering during navigation).
  registerDropHandler(handler: DropHandler): () => void {
    this.dropHandler = handler
    return () => {
      if (this.dropHandler === handler) this.dropHandler = null
    }
  }

  // Execute a drop at the service layer. Used by shared components (breadcrumb)
  // that don't own the move-execution logic. Screen-owned components (file
  // rows) can either call this OR run their own copyMove call directly —
  // both are valid; this just centralizes the path.
  //
  // Always clears the drag, even on a rejected/no-op drop, so dragend doesn't
  // also have to fire to reset state.
  dropOnPath(targetPath: string): void {
    const payload = this._payload()
    this._payload.set(null)
    if (!payload) return
    if (payload.sourceDir === targetPath) return
    this.dropHandler?.(targetPath, payload.files)
  }

  // May the current drag drop onto this row?
  //   - No drag in flight → false (drop targets show no hover state)
  //   - Target is a file (not a folder) → false
  //   - Target is one of the dragged files → false (can't drop a folder on itself)
  //
  // Note: descendant-of-dragged-folder isn't checked here. Reaching it via
  // the UI requires navigating *into* the descendant, which unmounts the
  // source row and ends the drag. The backend rejects the move with a clear
  // error if a determined user finds another path.
  canDropOnFile(target: Pick<FileProps, 'id' | 'isDir'>): boolean {
    const p = this._payload()
    if (!p) return false
    if (!target.isDir) return false
    if (p.draggedIds.has(target.id)) return false
    return true
  }

  // May the current drag drop onto this directory path?
  //   - No drag in flight → false
  //   - Target path is the same as the source directory → false (no-op)
  //
  // Used by the breadcrumb (drop onto a parent segment).
  canDropOnPath(targetPath: string): boolean {
    const p = this._payload()
    if (!p) return false
    if (p.sourceDir === targetPath) return false
    return true
  }
}
