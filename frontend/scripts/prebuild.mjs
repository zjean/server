import { checkPdfjs } from './pdfjs.mjs'

if (process.env.NODE_ENV !== 'development') {
  console.log('build assets ...')
  // Awaited and unguarded: swallowing the rejection would let ng build copy an
  // empty src/assets/pdfjs (404 on /assets/pdfjs/web/viewer.html in production).
  await checkPdfjs()
}
