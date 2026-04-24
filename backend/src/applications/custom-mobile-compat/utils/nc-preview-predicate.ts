// Decide whether the server would be able to produce a preview thumbnail for a
// given MIME type. Mirrors the categories stock Nextcloud servers advertise
// via <nc:has-preview>. The NC mobile clients only request a preview when
// this is true; otherwise they fall back to a mime-type icon.

const PREVIEWABLE_PREFIXES = ['image/']
const PREVIEWABLE_EXACT = new Set<string>([
  // Sync-in's FilesManager.generateThumbnail only handles image/* today (it
  // delegates to common/image, which rejects anything else with a 400). We
  // keep the predicate in lockstep so <nc:has-preview> is never true for a
  // mime the server would then 404 on — that roundtrip is worse UX (NC iOS
  // falls back to a full download per thumbnail) than showing a type icon.
])

export function ncHasPreview(mime: string | undefined | null): boolean {
  if (!mime) return false
  const normalized = mime.toLowerCase().replace('-', '/') // Sync-in stores dashes
  if (PREVIEWABLE_EXACT.has(normalized)) return true
  return PREVIEWABLE_PREFIXES.some((p) => normalized.startsWith(p))
}
