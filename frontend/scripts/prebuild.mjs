import { checkPdfjs } from './pdfjs.mjs'

if (process.env.NODE_ENV !== 'development') {
  console.log('build assets ...')
  // Top-level await: without it the prebuild script can exit between fs.rm and
  // extract(), leaving src/assets/pdfjs empty by the time ng build copies assets
  // (404 on /assets/pdfjs/web/viewer.html in production).
  await checkPdfjs().catch(console.error)
}
