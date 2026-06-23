import { fileURLToPath } from 'url'
import fs from 'node:fs/promises'
import path from 'node:path'
import constants from 'node:constants'
import os from 'node:os'
import { Readable } from 'node:stream'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js/index-native.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Pin PDF.js to a known-good release. PDF.js ships breaking changes that have
// repeatedly broken PDF rendering when the build silently pulled "latest" — v6
// introduced a strict viewer meta-CSP (broke the inline polyfill, fixed in #272)
// and a QuickJS WASM scripting sandbox (needs 'wasm-unsafe-eval', fixed in #273).
// Bump this deliberately, and re-verify the viewer + scripting sandbox load
// (and that patchForBrowserCompat still finds its anchors) before committing.
const PINNED_VERSION = 'v6.0.227'
const releaseURL = `https://api.github.com/repos/mozilla/pdf.js/releases/tags/${PINNED_VERSION}`
let pinnedDownloadURL
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

async function extractZip(zipPath, destination) {
  const zipData = await fs.readFile(zipPath)
  const zipReader = new ZipReader(new Uint8ArrayReader(zipData))
  const destinationPath = path.resolve(destination)

  try {
    const entries = await zipReader.getEntries()
    for (const entry of entries) {
      const entryPath = path.resolve(destinationPath, entry.filename)
      if (entryPath !== destinationPath && !entryPath.startsWith(`${destinationPath}${path.sep}`)) {
        throw new Error(`Invalid ZIP entry path: ${entry.filename}`)
      }
      if (entry.directory) {
        await fs.mkdir(entryPath, { recursive: true })
        continue
      }
      await fs.mkdir(path.dirname(entryPath), { recursive: true })
      await fs.writeFile(entryPath, await entry.getData(new Uint8ArrayWriter()))
    }
  } finally {
    await zipReader.close()
  }
}

async function updatePdfjs() {
  console.log('pdfjs - downloading pinned version:', pinnedDownloadURL)
  const tmpZip = path.join(os.tmpdir(), 'pdfjs-pinned.zip')
  const response = await fetch(pinnedDownloadURL)
  await fs.writeFile(tmpZip, Readable.fromWeb(response.body))
  console.log('pdfjs - downloaded:', tmpZip)
  await fs.rm(pdfjsAssetsDirectory, { recursive: true, force: true })
  await extractZip(tmpZip, pdfjsAssetsDirectory)
  console.log('pdfjs - extracted:', pdfjsAssetsDirectory)
  const viewerHtml = path.join(pdfjsAssetsDirectory, 'web', 'viewer.html')
  if (!(await checkPaths([viewerHtml]))) {
    console.warn(`${viewerHtml} is missing`)
  }
  await fs.writeFile(pdfjsAssetsVersionFile, PINNED_VERSION)
  console.log('pdfjs - assets update is done')
}

// Map.prototype.getOrInsertComputed (TC39 proposal) is called by PDF.js 5.x/6.x on
// BOTH the main thread (build/pdf.mjs) and the worker (build/pdf.worker.mjs), but is
// only available in Chrome 136+. We must polyfill it for Firefox and Safari.
//
// It MUST be delivered by prepending it to the module bundles, NOT as an inline
// <script> in viewer.html: pdf.js's viewer.html ships its own strict meta CSP
// (`script-src 'self' 'wasm-unsafe-eval'` — no 'unsafe-inline', no hash, no nonce),
// which blocks inline scripts. `script-src 'self'` does allow the same-origin module
// files, so prepending to them runs the polyfill before any getOrInsertComputed call.
const COMPAT_POLYFILL =
  'if(!Map.prototype.getOrInsertComputed){Map.prototype.getOrInsertComputed=function(k,f){if(!this.has(k))this.set(k,f(k));return this.get(k);}}\n'

// Distinctive marker for idempotency. Native pdf.js code only ever *calls*
// `.getOrInsertComputed(`, so guarding on the bare method name would falsely report
// "already patched"; guard on the polyfill's assignment form instead.
const POLYFILL_MARKER = 'getOrInsertComputed=function'

async function prependPolyfill(filePath, label) {
  let content
  try {
    content = await fs.readFile(filePath, 'utf8')
  } catch {
    console.warn(`pdfjs - ${label} not found at ${filePath}; polyfill skipped (PDF.js layout may have changed)`)
    return
  }
  if (content.includes(POLYFILL_MARKER)) return
  await fs.writeFile(filePath, COMPAT_POLYFILL + content)
  console.log(`pdfjs - patched ${label} (Map.getOrInsertComputed polyfill)`)
}

async function patchForBrowserCompat() {
  try {
    const buildDir = path.join(pdfjsAssetsDirectory, 'build')
    await prependPolyfill(path.join(buildDir, 'pdf.mjs'), 'pdf.mjs (main thread)')
    await prependPolyfill(path.join(buildDir, 'pdf.worker.mjs'), 'pdf.worker.mjs (worker)')
    await prependPolyfill(path.join(buildDir, 'pdf.sandbox.mjs'), 'pdf.sandbox.mjs (scripting)')

    // Earlier builds injected the polyfill as an inline <script> in viewer.html.
    // That is blocked by viewer.html's own meta CSP and only produces console noise,
    // so strip it if a previous run (or an older asset cache) left it behind.
    const viewerHtml = path.join(pdfjsAssetsDirectory, 'web', 'viewer.html')
    try {
      const html = await fs.readFile(viewerHtml, 'utf8')
      const stripped = html.replace(`<script>${COMPAT_POLYFILL.trim()}</script>\n`, '')
      if (stripped !== html) {
        await fs.writeFile(viewerHtml, stripped)
        console.log('pdfjs - removed stale inline polyfill <script> from viewer.html (CSP-blocked)')
      }
    } catch {
      /* viewer.html missing is already reported elsewhere */
    }
  } catch (e) {
    console.warn('pdfjs - browser-compat patch failed:', e.message)
  }
}

export async function checkPdfjs() {
  console.log('pdfjs - pinned version:', PINNED_VERSION)
  // Fast path: assets already at the pinned version — re-apply the compat patch
  // (idempotent) and skip the network entirely.
  if (await checkPaths([pdfjsAssetsDirectory, pdfjsAssetsVersionFile])) {
    const currentVersion = (await fs.readFile(pdfjsAssetsVersionFile, { encoding: 'utf8' })).trim()
    console.log('pdfjs - current version:', currentVersion)
    if (currentVersion === PINNED_VERSION) {
      console.log('pdfjs - is at pinned version')
      await patchForBrowserCompat()
      return
    }
  }
  // (Re)download the pinned release.
  let response
  try {
    response = await fetch(releaseURL)
  } catch (e) {
    console.error('pdfjs -', e.message, releaseURL)
    return
  }
  let data
  try {
    data = await response.json()
  } catch (e) {
    console.error('pdfjs - unable to fetch release metadata:', e.message)
    return
  }
  if (!data || !Array.isArray(data.assets) || data.assets.length === 0) {
    console.error(`pdfjs - no release assets for ${PINNED_VERSION} (${releaseURL}) — is the tag correct?`, data && data.message ? `[${data.message}]` : '')
    return
  }
  pinnedDownloadURL = data.assets[0]['browser_download_url']
  await updatePdfjs()
  await patchForBrowserCompat()
}
