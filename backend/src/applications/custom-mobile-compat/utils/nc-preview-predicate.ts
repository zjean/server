// Decide whether the server would be able to produce a preview thumbnail for a
// given MIME type. Mirrors the categories stock Nextcloud servers advertise
// via <nc:has-preview>. The NC mobile clients only request a preview when
// this is true; otherwise they fall back to a mime-type icon.

const PREVIEWABLE_PREFIXES = ['image/']
const PREVIEWABLE_EXACT = new Set<string>([
  'application/pdf',
  // Leaving video and audio off for now — Sync-in's preview endpoint only
  // handles images today. Advertising a preview here and returning 404 for it
  // pushes the client to fall back to a full download per request, which is
  // worse than just showing a type icon.
])

export function ncHasPreview(mime: string | undefined | null): boolean {
  if (!mime) return false
  const normalized = mime.toLowerCase().replace('-', '/') // Sync-in stores dashes
  if (PREVIEWABLE_EXACT.has(normalized)) return true
  return PREVIEWABLE_PREFIXES.some((p) => normalized.startsWith(p))
}
