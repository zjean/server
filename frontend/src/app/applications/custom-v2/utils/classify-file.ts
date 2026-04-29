import { COLLABORA_ONLINE_EXTENSIONS } from '@sync-in-server/backend/src/applications/files/modules/collabora-online/collabora-online.constants'
import { ONLY_OFFICE_EXTENSIONS } from '@sync-in-server/backend/src/applications/files/modules/only-office/only-office.constants'
import { MAX_TEXT_FILE_SIZE, UNSUPPORTED_VIEW_EXTENSIONS } from '../../files/files.constants'
import { isAudioMime, isImageMime, isPdfMime, isVideoMime } from './mime-to-glyph'
import { isOfficeExtension } from './office'

interface ClassifiableFile {
  name: string
  mime?: string | null
  size?: number
  isDir?: boolean
}

// Mirrors classic FileModel.getMime() classification for the "is this a plain
// text/code file we can open in CodeMirror?" decision. Conservative: anything
// that the classic UI would route to an Office editor (Collabora/OnlyOffice)
// is *not* considered text-editable here, even if no Office provider is wired
// up — opening a .docx/.xlsx in CodeMirror would just show binary garbage.
export function isTextEditable(file: ClassifiableFile): boolean {
  if (file.isDir) return false
  if (file.size != null && file.size > MAX_TEXT_FILE_SIZE) return false
  if (isImageMime(file.mime) || isPdfMime(file.mime) || isVideoMime(file.mime) || isAudioMime(file.mime)) return false
  const ext = getExtension(file.name).toLowerCase()
  if (UNSUPPORTED_VIEW_EXTENSIONS.has(ext)) return false
  if (ONLY_OFFICE_EXTENSIONS.has(ext) || COLLABORA_ONLINE_EXTENSIONS.has(ext)) return false
  return true
}

// Files the unified preview overlay (and standalone /v2/preview route) can
// render directly. Phases A-E cover images, PDFs, OnlyOffice, text/code,
// and audio/video. Anything else falls through to the no-preview download
// fallback inside the overlay.
export function isPreviewable(file: ClassifiableFile): boolean {
  if (file.isDir) return false
  return (
    isImageMime(file.mime) ||
    isPdfMime(file.mime) ||
    isOfficeExtension(file.name) ||
    isTextEditable(file) ||
    isVideoMime(file.mime) ||
    isAudioMime(file.mime)
  )
}

function getExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1)
}
