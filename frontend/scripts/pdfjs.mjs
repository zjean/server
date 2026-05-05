import { fileURLToPath } from 'url'
import fs from 'node:fs/promises'
import path from 'node:path'
import constants from 'node:constants'
import os from 'node:os'
import { Readable } from 'node:stream'
import extract from 'extract-zip'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let latestVersion
let latestDownloadURL
const latestURL = 'https://api.github.com/repos/mozilla/pdf.js/releases/latest'
const pdfjsAssetsDirectory = path.join(__dirname, '..', 'src', 'assets', 'pdfjs')
const pdfjsAssetsVersionFile = path.join(pdfjsAssetsDirectory, 'version')

async function checkPaths(paths) {
  try {
    for (const p of paths) {
      await fs.access(p, constants.R_OK | constants.W_OK)
    }
    return true
  } catch {
    return false
  }
}

async function updatePdfjs() {
  console.log('pdfjs - update to the latest version:', latestDownloadURL)
  const tmpZip = path.join(os.tmpdir(), 'pdfjs-latest.zip')
  const response = await fetch(latestDownloadURL)
  await fs.writeFile(tmpZip, Readable.fromWeb(response.body))
  console.log('pdfjs - downloaded:', tmpZip)
  await fs.rm(pdfjsAssetsDirectory, { recursive: true, force: true })
  await extract(tmpZip, { dir: pdfjsAssetsDirectory })
  console.log('pdfjs - unzipped:', pdfjsAssetsDirectory)
  const viewerHtml = path.join(pdfjsAssetsDirectory, 'web', 'viewer.html')
  if (!(await checkPaths([viewerHtml]))) {
    console.warn(`${viewerHtml} is missing`)
  }
  await fs.writeFile(pdfjsAssetsVersionFile, latestVersion)
  console.log('pdfjs - assets update is done')
}

// Map.prototype.getOrInsertComputed (TC39 proposal) is used by PDF.js 5.x but is
// only available in Chrome 136+. Polyfill both the viewer (main thread) and the
// worker (separate global scope) so PDFs open in Firefox and Safari too.
const COMPAT_POLYFILL =
  'if(!Map.prototype.getOrInsertComputed){Map.prototype.getOrInsertComputed=function(k,f){if(!this.has(k))this.set(k,f(k));return this.get(k);}}\n'

async function patchForBrowserCompat() {
  try {
    const viewerHtml = path.join(pdfjsAssetsDirectory, 'web', 'viewer.html')
    const html = await fs.readFile(viewerHtml, 'utf8')
    if (!html.includes('getOrInsertComputed')) {
      await fs.writeFile(
        viewerHtml,
        html.replace(
          '<!-- This snippet is used in production',
          `<script>${COMPAT_POLYFILL.trim()}</script>\n<!-- This snippet is used in production`
        )
      )
      console.log('pdfjs - patched viewer.html (Map.getOrInsertComputed polyfill)')
    }

    const workerMjs = path.join(pdfjsAssetsDirectory, 'build', 'pdf.worker.mjs')
    const worker = await fs.readFile(workerMjs, 'utf8')
    if (!worker.startsWith('if(!Map')) {
      await fs.writeFile(workerMjs, COMPAT_POLYFILL + worker)
      console.log('pdfjs - patched pdf.worker.mjs (Map.getOrInsertComputed polyfill)')
    }
  } catch (e) {
    console.warn('pdfjs - browser-compat patch failed:', e.message)
  }
}

export async function checkPdfjs() {
  let response
  try {
    response = await fetch(latestURL)
  } catch (e) {
    console.error('pdfjs -', e.message, latestURL)
    return
  }
  let data
  try {
    data = await response.json()
  } catch (e) {
    console.error('pdfjs - unable to check update:', e.message)
    return
  }
  latestVersion = data.tag_name
  latestDownloadURL = data.assets[0]['browser_download_url']
  console.log('pdfjs - latest version:', latestVersion)
  if (await checkPaths([pdfjsAssetsDirectory, pdfjsAssetsVersionFile])) {
    const currentVersion = await fs.readFile(pdfjsAssetsVersionFile, { encoding: 'utf8' })
    console.log('pdfjs - current version:', currentVersion)
    if (currentVersion === latestVersion) {
      console.log('pdfjs - is up to date')
      await patchForBrowserCompat()
      return
    }
  }
  await updatePdfjs()
  await patchForBrowserCompat()
}
