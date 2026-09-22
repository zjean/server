import { fileURLToPath } from 'url'
import fs from 'node:fs/promises'
import path from 'node:path'
import constants from 'node:constants'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js/index-native.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Fork: pinned AHEAD of upstream's v5.6.205. PDF.js v6 introduced a strict viewer
// meta-CSP (broke the inline polyfill, fixed in #272) and a QuickJS WASM scripting
// sandbox (needs 'wasm-unsafe-eval', fixed in #273); patchForBrowserCompat below is
// what makes v6 work here. Bump deliberately, and re-verify the viewer + scripting
// sandbox load (and that patchForBrowserCompat still finds its anchors) first.
const pdfjsVersion = 'v6.0.227'
const pdfjsDownloadAsset = `pdfjs-${pdfjsVersion.slice(1)}-dist.zip`
const pdfjsReleaseURL = `https://api.github.com/repos/mozilla/pdf.js/releases/tags/${pdfjsVersion}`
const pdfjsAssetsDirectory = path.join(__dirname, '..', 'src', 'assets', 'pdfjs')
const pdfjsAssetsVersionFile = path.join(pdfjsAssetsDirectory, 'version')
const pdfjsViewerFile = path.join(pdfjsAssetsDirectory, 'web', 'viewer.html')
const pdfjsRequestAttempts = 3
const pdfjsRequestRetryDelay = 3_000
const pdfjsRequestTimeout = 60_000

async function fetchPdfjs(url, readResponse) {
  for (let attempt = 1; attempt <= pdfjsRequestAttempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(pdfjsRequestTimeout) })
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText} ${url}`)
      }
      return await readResponse(response)
    } catch (error) {
      if (attempt === pdfjsRequestAttempts) {
        throw error
      }
      console.warn(`pdfjs - request failed (${attempt}/${pdfjsRequestAttempts}): ${error instanceof Error ? error.message : error}; retrying in 3s`)
      await new Promise((resolve) => setTimeout(resolve, pdfjsRequestRetryDelay))
    }
  }
}

async function checkPaths(paths) {
  try {
    for (const p of paths) {
      await fs.access(p, constants.R_OK)
    }
    return true
  } catch {
    return false
  }
}

async function extractZip(zipData, destination) {
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

async function updatePdfjs(pdfjsDownloadURL) {
  console.log('pdfjs - update to version:', pdfjsVersion, pdfjsDownloadURL)
  const zipData = await fetchPdfjs(pdfjsDownloadURL, async (response) => {
    if (!response.body) {
      throw new Error(`pdfjs - unable to download: empty response body ${pdfjsDownloadURL}`)
    }
    return new Uint8Array(await response.arrayBuffer())
  })
  console.log('pdfjs - downloaded')
  await fs.rm(pdfjsAssetsDirectory, { recursive: true, force: true })
  await extractZip(zipData, pdfjsAssetsDirectory)
  console.log('pdfjs - extracted:', pdfjsAssetsDirectory)
  if (!(await checkPaths([pdfjsViewerFile]))) {
    throw new Error(`${pdfjsViewerFile} is missing`)
  }
  await fs.writeFile(pdfjsAssetsVersionFile, pdfjsVersion)
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
  console.log('pdfjs - target version:', pdfjsVersion)
  if (await checkPaths([pdfjsAssetsDirectory, pdfjsAssetsVersionFile, pdfjsViewerFile])) {
    const currentVersion = await fs.readFile(pdfjsAssetsVersionFile, { encoding: 'utf8' })
    console.log('pdfjs - current version:', currentVersion)
    if (currentVersion === pdfjsVersion) {
      console.log('pdfjs - is up to date')
      // Fork: the fast path skips updatePdfjs entirely, so re-apply the compat
      // patch here. It is idempotent (POLYFILL_MARKER guard).
      await patchForBrowserCompat()
      return
    }
  }
  const data = await fetchPdfjs(pdfjsReleaseURL, (response) => response.json())
  const asset = data.assets.find((a) => a.name === pdfjsDownloadAsset)
  if (!asset) {
    throw new Error(`pdfjs - unable to find asset: ${pdfjsDownloadAsset}`)
  }
  await updatePdfjs(asset.browser_download_url)
  await patchForBrowserCompat()
}
