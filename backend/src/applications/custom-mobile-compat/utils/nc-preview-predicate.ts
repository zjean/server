// Decide whether the server can produce a preview for a given MIME type.
// Drives <nc:has-preview> in PROPFIND: NC mobile clients only request a
// preview when this is true; otherwise they fall back to a mime-type icon.
// Sync-in's FilesManager.generateThumbnail handles image/* (sharp on the
// happy path, original-bytes fallback for formats sharp can't decode) and
// rejects everything else with 400 — keep the predicate in lockstep.

export function ncHasPreview(mime: string | undefined | null): boolean {
  if (!mime) return false
  // Sync-in stores mimes as `image-jpeg`; only the first dash is the slash.
  return mime.toLowerCase().startsWith('image-') || mime.toLowerCase().startsWith('image/')
}
