import { COLLABORA_ONLINE_EXTENSIONS } from '@sync-in-server/backend/src/applications/files/modules/collabora-online/collabora-online.constants'
import { ONLY_OFFICE_EXTENSIONS } from '@sync-in-server/backend/src/applications/files/modules/only-office/only-office.constants'
import { MAX_TEXT_FILE_SIZE, UNSUPPORTED_VIEW_EXTENSIONS } from '../../files/files.constants'
import { isAudioMime, isImageMime, isPdfMime, isVideoMime } from './mime-to-glyph'

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

function getExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1)
}

const DIAGRAM_EXTENSIONS = new Set(['drawio', 'dwb'])

export function isDiagramExt(name: string): boolean {
  return DIAGRAM_EXTENSIONS.has(getExtension(name).toLowerCase())
}
