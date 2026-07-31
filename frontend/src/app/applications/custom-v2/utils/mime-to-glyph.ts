import { FileGlyphType } from '../components/file-glyph.component'

// The spaces browse API returns mimes with '/' replaced by '-' — e.g. 'image-jpeg'
// instead of 'image/jpeg' (backend/src/applications/files/utils/files.ts:95).
// Normalize back to the canonical form before any type/subtype checks.
export function normalizeMime(mime: string | null | undefined): string {
  if (!mime) return ''
  return mime.replace('-', '/').toLowerCase()
}

export function isImageMime(mime: string | null | undefined): boolean {
  return normalizeMime(mime).startsWith('image/')
}

export function isPdfMime(mime: string | null | undefined): boolean {
  return normalizeMime(mime) === 'application/pdf'
}

export function isVideoMime(mime: string | null | undefined): boolean {
  return normalizeMime(mime).startsWith('video/')
}

export function isAudioMime(mime: string | null | undefined): boolean {
  return normalizeMime(mime).startsWith('audio/')
}

// Markdown files. Detected by mime substring (mirrors upstream FileModel.getMime():
// `mime.includes('markdown')` handles both `text/markdown` and the dashed
// `text-markdown` form the browse API emits) or by `.md` / `.markdown` /
// `.mdown` extension (some servers don't set the mime correctly on upload).
export function isMarkdownMime(mime: string | null | undefined, fileName?: string): boolean {
  const m = normalizeMime(mime)
  if (m.includes('markdown')) return true
  if (!fileName) return false
  const dot = fileName.lastIndexOf('.')
  if (dot < 0 || dot === fileName.length - 1) return false
  const ext = fileName.slice(dot + 1).toLowerCase()
  return ext === 'md' || ext === 'markdown' || ext === 'mdown'
}

// Text/code files the v2 text viewer can render inline via CodeMirror.
// Office-ish formats (msword/officedocument/opendocument) are excluded; those
// need the OnlyOffice embed from phase 4.11.
export function isTextViewerMime(mime: string | null | undefined): boolean {
  const m = normalizeMime(mime)
  if (!m) return false
  if (m.startsWith('text/')) {
    if (m.includes('officedocument') || m.includes('opendocument')) return false
    return true
  }
  return (
    m === 'application/json' ||
    m === 'application/xml' ||
    m === 'application/javascript' ||
    m === 'application/typescript' ||
    m === 'application/x-sh' ||
    m === 'application/x-yaml'
  )
}

// Archive MIME types Sync-in can decompress (mirrors the classic
// `decompressFile` gate). Single source of truth for both the file glyph and
// the v2 "Decompress" context-menu gate.
const ARCHIVE_MIMES = new Set([
  'application/zip',
  'application/x-7z-compressed',
  'application/x-tar',
  'application/x-rar-compressed',
  'application/gzip',
  'application/x-bzip2'
])

export function isArchiveMime(mime: string | null | undefined): boolean {
  return ARCHIVE_MIMES.has(normalizeMime(mime))
}

// Human-readable name for a MIME type.
//
// The file-detail header printed `f.mime` verbatim: 71 characters of machine
// string in the slot where a label belongs, truncated mid-word. Worse, the
// browse API's stored form replaces the first '/' with '-', so what reached the
// user ('application-vnd.openxmlformats-...') was not even a valid MIME type.
//
// Exact matches first, then family prefixes, then a last-resort tidy-up of the
// subtype so an unknown mime still reads as words rather than as a path.
const MIME_NAMES: Record<string, string> = {
  'application/pdf': 'PDF document',
  'application/msword': 'Word document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document',
  'application/vnd.oasis.opendocument.text': 'OpenDocument text',
  'application/vnd.ms-excel': 'Excel spreadsheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel spreadsheet',
  'application/vnd.oasis.opendocument.spreadsheet': 'OpenDocument spreadsheet',
  'application/vnd.ms-powerpoint': 'PowerPoint presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint presentation',
  'application/vnd.oasis.opendocument.presentation': 'OpenDocument presentation',
  'application/json': 'JSON file',
  'application/xml': 'XML file',
  'application/rtf': 'Rich text document',
  'application/zip': 'ZIP archive',
  'application/x-7z-compressed': '7z archive',
  'application/x-tar': 'TAR archive',
  'application/x-rar-compressed': 'RAR archive',
  'application/gzip': 'Gzip archive',
  'application/x-bzip2': 'Bzip2 archive',
  'text/plain': 'Text file',
  'text/markdown': 'Markdown file',
  'text/csv': 'CSV file',
  'text/html': 'HTML file',
  'text/css': 'Stylesheet',
  'inode/directory': 'Folder',
  folder: 'Folder'
}

const MIME_FAMILIES: [string, string][] = [
  ['image/', 'image'],
  ['video/', 'video'],
  ['audio/', 'audio'],
  ['font/', 'font']
]

export function mimeLabel(mime: string | null | undefined): string {
  const m = normalizeMime(mime)
  if (!m) return 'Unknown type'

  const exact = MIME_NAMES[m]
  if (exact) return exact

  const [type, subtype = ''] = m.split('/')

  // image/png -> "PNG image", video/quicktime -> "QuickTime video"
  for (const [prefix, noun] of MIME_FAMILIES) {
    if (!m.startsWith(prefix)) continue
    const short = subtype.replace(/^x-/, '').replace(/\+.*$/, '')
    return short ? `${short.toUpperCase()} ${noun}` : `${type} file`
  }

  if (!subtype) return `${type} file`
  // Strip vendor/suffix noise, then take the most specific segment:
  // 'vnd.oasis.opendocument.chart' -> 'chart'
  const cleaned = subtype
    .replace(/^(vnd|x|prs)[.-]/, '')
    .replace(/\+.*$/, '')
    .split('.')
    .pop()!
    .replace(/[-_]/g, ' ')
    .trim()
  if (!cleaned) return `${type} file`
  return `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)} file`
}

// Map a MIME type to one of the v2 FileGlyph categories.
// Unknown mimes fall through to 'default', which the FileGlyph renders as a
// neutral document glyph.
export function mimeToGlyph(mime: string | null | undefined): FileGlyphType {
  if (!mime) return 'default'
  const m = normalizeMime(mime)

  if (m === 'inode/directory' || m === 'folder') return 'folder'
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (m === 'application/pdf') return 'pdf'

  if (
    m.includes('spreadsheet') ||
    m.includes('excel') ||
    m.includes('opendocument.spreadsheet') ||
    m === 'text/csv' ||
    m === 'text/tab-separated-values'
  ) {
    return 'sheet'
  }

  if (m.includes('presentation') || m.includes('powerpoint') || m.includes('opendocument.presentation')) {
    return 'deck'
  }

  if (isArchiveMime(m)) {
    return 'archive'
  }

  if (
    m === 'application/javascript' ||
    m === 'application/typescript' ||
    m === 'application/json' ||
    m === 'application/xml' ||
    m === 'text/x-python' ||
    m === 'text/x-java-source' ||
    m === 'text/x-c' ||
    m === 'text/x-c++src' ||
    m === 'text/x-go' ||
    m === 'text/x-rust' ||
    m === 'text/x-ruby' ||
    m === 'text/x-shellscript' ||
    m === 'text/html' ||
    m === 'text/css' ||
    (m.startsWith('application/x-') && (m.endsWith('-script') || m.includes('source')))
  ) {
    return 'code'
  }

  if (
    m.startsWith('text/') ||
    m.includes('msword') ||
    m.includes('officedocument.wordprocessingml') ||
    m.includes('opendocument.text') ||
    m === 'application/rtf'
  ) {
    return 'doc'
  }

  return 'default'
}
