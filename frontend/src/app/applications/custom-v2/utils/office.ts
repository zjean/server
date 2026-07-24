import { ONLY_OFFICE_EXTENSIONS } from '@sync-in-server/backend/src/applications/files/editors/only-office/only-office.constants'

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
