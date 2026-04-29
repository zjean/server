import { V2_PATH, V2_ROUTES } from '../v2.constants'

// Open the chromeless preview in a new browser tab. Used by the middle-
// click (auxclick) handler on file rows. The `#` prefix is load-bearing:
// the app uses HashLocationStrategy and the backend has no SPA fallback
// for non-hash paths — a bare /v2/preview?... would 404 in the new tab.
export function openPreviewInNewTab(path: string): void {
  if (typeof window === 'undefined' || !path) return
  const url = `/#/${V2_PATH}/${V2_ROUTES.PREVIEW}?path=${encodeURIComponent(path)}`
  window.open(url, '_blank', 'noopener')
}
