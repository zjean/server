import { V2_PATH, V2_ROUTES } from '../v2.constants'

// Open a PDF in a new browser tab using the chromeless v2 PDF.js viewer.
// Triggered from a user click — popup blockers allow this.
export function openPdfInNewTab(path: string): void {
  if (typeof window === 'undefined' || !path) return
  const url = `/${V2_PATH}/${V2_ROUTES.PDF}?path=${encodeURIComponent(path)}`
  window.open(url, '_blank', 'noopener')
}
