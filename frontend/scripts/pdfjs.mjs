import { fileURLToPath } from 'url'
import fs from 'node:fs/promises'
import path from 'node:path'
import constants from 'node:constants'
import os from 'node:os'
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'

function extract(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('unzip', ['-q', '-o', zipPath, '-d', destDir], { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`unzip exited with code ${code}`))))
  })
}

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
  await fs.mkdir(pdfjsAssetsDirectory, { recursive: true })
  await extract(tmpZip, pdfjsAssetsDirectory)
  console.log('pdfjs - unzipped:', pdfjsAssetsDirectory)
  const viewerHtml = path.join(pdfjsAssetsDirectory, 'web', 'viewer.html')
  if (!(await checkPaths([viewerHtml]))) {
    console.warn(`${viewerHtml} is missing`)
  }
  await fs.writeFile(pdfjsAssetsVersionFile, latestVersion)
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
