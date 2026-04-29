import { V2_PATH, V2_ROUTES } from '../v2.constants'

// Open a PDF in a new browser tab using the chromeless v2 PDF.js viewer.
// Triggered from a user click — popup blockers allow this.
//
// The `#` prefix is load-bearing: the app uses HashLocationStrategy
// (app.config.ts) and the backend has no SPA fallback for non-hash paths,
// so a bare `/v2/pdf?...` URL would 404 in the new tab.
export function openPdfInNewTab(path: string): void {
  if (typeof window === 'undefined' || !path) return
  const url = `/#/${V2_PATH}/${V2_ROUTES.PDF}?path=${encodeURIComponent(path)}`
  window.open(url, '_blank', 'noopener')
}
