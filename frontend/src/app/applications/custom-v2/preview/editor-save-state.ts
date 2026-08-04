// What an embedded editor reports about the file it holds, so its host can draw
// the state instead of the editor describing it in prose.
//
// The design's diagnosis, verbatim: "Save state is a badge, not a sentence — the
// old `Read-only (user – Sync-in)` string is gone." A sentence inside the editor's
// own toolbar is both the wrong place (the state is about the FILE, which the
// identity band names) and the wrong shape (five words where a badge does it in
// one).
//
// The editors still render the sentence in `inline` mode — the folder-readme
// banner has no identity band to carry a badge, so there the toolbar is the only
// place the state can live.
export type EditorSaveState = 'loading' | 'saving' | 'modified' | 'saved' | 'readonly'

export interface EditorStatus {
  state: EditorSaveState
  /** Who holds the lock, when `state` is 'readonly' because someone else does. */
  lockOwner?: string | null
}
