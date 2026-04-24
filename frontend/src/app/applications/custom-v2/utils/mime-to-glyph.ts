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

  if (
    m === 'application/zip' ||
    m === 'application/x-7z-compressed' ||
    m === 'application/x-tar' ||
    m === 'application/x-rar-compressed' ||
    m === 'application/gzip' ||
    m === 'application/x-bzip2'
  ) {
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
