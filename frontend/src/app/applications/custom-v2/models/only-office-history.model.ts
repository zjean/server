import type {
  EditorHistoryEntry,
  EditorVersionData
} from '@sync-in-server/backend/src/applications/custom-versioning/interfaces/editor-history.interface'

// The OnlyOffice document server's version-history API, as seen from the page.
//
// FORK-OWNED rather than an extension of upstream's `only-office.interface.ts`,
// deliberately. That file types all four history events as
// `(event: object) => void` and declares NEITHER of the two `docEditor` methods
// they have to call — so using it would give no type safety where the mistakes
// actually happen (the ordinal inside `event.data`, the shape handed to
// `refreshHistory`), while putting a second fork edit on a file that is already
// on the merge-conflict surface every upstream sync.

// One panel row, after the client-side massaging `refreshHistory` performs.
//
// `created` is a LOCALE STRING here, not the unix seconds the server sent:
// upstream reformats every entry before handing the array over
// (`editor.js:734-735`), so the editor is given text to display rather than a
// number to interpret.
export type OnlyOfficeHistoryRow = Omit<EditorHistoryEntry, 'created'> & { created: string }

// What `docEditor.refreshHistory` takes.
//
// `currentVersion` is computed IN THE PAGE as the maximum ordinal present
// (`editor.js:728-745`) — the server does not send it. That is also why the live
// file has to be in the array: it is the entry that makes `currentVersion` mean
// "now".
export interface OnlyOfficeHistoryData {
  currentVersion: number
  history: OnlyOfficeHistoryRow[]
}

// The two methods on a DocEditor instance this feature calls. `window.DocEditor`
// is typed `any` upstream (`only-office.utils.ts:4`), so this is what narrows it
// at the call site.
export interface OnlyOfficeHistoryEditor {
  refreshHistory(data: OnlyOfficeHistoryData | { error: string }): void
  setHistoryData(data: EditorVersionData | { error: string; version: number }): void
}

// The four events that make the editor offer a version panel at all. Without
// `onRequestHistory` there is no panel: the editor has no way to populate one, so
// it does not show the affordance.
//
// The argument shapes are upstream's (`editor.js:234-270`) and are inconsistent
// on purpose — `onRequestHistoryData` carries the ordinal as `event.data`, while
// `onRequestRestore` nests it as `event.data.version`. Getting these backwards
// yields `undefined` ordinals, which the server answers with a 404 that reads
// like a missing version.
// `void | Promise<void>` because the implementations fetch: the editor ignores
// whatever a handler returns, but a signature of plain `void` would make every
// call site unable to await one, including the tests.
export interface OnlyOfficeHistoryHooks {
  onRequestHistory?: () => void | Promise<void>
  onRequestHistoryData?: (event: { data: number }) => void | Promise<void>
  onRequestRestore?: (event: { data: { version: number } }) => void | Promise<void>
  onRequestHistoryClose?: () => void
}
