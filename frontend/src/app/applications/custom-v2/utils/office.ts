import type { FileEditorProviders } from '@sync-in-server/backend/src/applications/files/editors/file-editor-providers.interface'
import { ONLY_OFFICE_EXTENSIONS } from '@sync-in-server/backend/src/applications/files/editors/only-office/only-office.constants'

// True when this server has an office editor v2's embed can actually talk to.
//
// v2's embed speaks the OnlyOffice connector protocol only — see
// preview/office-view.component.ts, which mounts upstream's
// <app-files-onlyoffice-document> and calls API_ONLY_OFFICE_SETTINGS.
// Euro-Office rides that same protocol (it reuses ONLY_OFFICE_APP_LOCK and the
// OnlyOffice extension map), so it belongs here; Collabora does NOT — it has no
// v2 viewer at all, so a Collabora-only server must fall back to the standard
// preview rather than mount an embed that cannot load.
//
// This is deliberately narrower than classic's gate (file.model.ts:189-191),
// which also admits `collabora && COLLABORA_ONLINE_EXTENSIONS.has(ext)` because
// classic ships a Collabora viewer. Widening this to match classic verbatim
// would reintroduce the dead embed this predicate exists to prevent.
export function isOfficeEditorEnabled(editors: FileEditorProviders | null | undefined): boolean {
  return editors?.onlyoffice === true || editors?.eurooffice === true
}

// Returns true if the file's extension is one the OnlyOffice/Euro-Office
// editors know how to open. Both providers share the same extension map
// (see classic file.model.ts: the OnlyOffice set gates onlyoffice ||
// eurooffice); the backend ships the authoritative map, we just use it.
export function isOfficeExtension(name: string | null | undefined): boolean {
  if (!name) return false
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  const ext = name.slice(dot + 1).toLowerCase()
  return ONLY_OFFICE_EXTENSIONS.has(ext)
}

export function officeCategory(name: string | null | undefined): 'word' | 'cell' | 'slide' | 'pdf' | 'diagram' | null {
  if (!name) return null
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  const ext = name.slice(dot + 1).toLowerCase()
  return ONLY_OFFICE_EXTENSIONS.get(ext) ?? null
}
