import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import TextToSVG from 'text-to-svg'
import { maxFileSizeExceededError } from '../applications/files/utils/errors'
import { moveFiles } from '../applications/files/utils/files'

// Sharp settings
sharp.cache(false)
sharp.concurrency(Math.min(2, os.cpus()?.length || 1))
// SVG files must only be loaded from buffers so librsvg has no base directory
// from which it can resolve local external resources.
sharp.block({ operation: ['VipsForeignLoadSvgFile'] })

// Constants
export const imgMimeTypePrefix = 'image/'
export const pngMimeType = 'image/png'
export const svgMimeType = 'image/svg+xml'
export const webpMimeType = 'image/webp'
export const maxThumbnailInputSize = 50 * 1024 * 1024
// Fork (#503): ceiling on the "sharp cannot decode this — stream the original
// instead" fallback in FilesManager.generateThumbnail. Deliberately an order of
// magnitude below maxThumbnailInputSize: that one bounds what we are willing to
// DECODE (the response is a ~tens-of-KB webp either way), this one bounds what
// we are willing to SEND VERBATIM, once per grid tile. At 50 MB a folder of 30
// iPhone HEICs was ~1.5 GB of egress for one render. 8 MB still covers real
// phone captures (HEIC/AVIF are typically 1-3 MB) while capping a full grid at
// a few hundred MB worst case; past it the client gets the pre-fallback refusal
// and renders its generic file icon.
export const maxThumbnailFallbackSize = 8 * 1024 * 1024
const avatarSize = 512
const fontPath = path.join(__dirname, 'fonts', 'avatar.ttf')
const loadTextToSVG = promisify(TextToSVG.load.bind(TextToSVG))
let textToSvgCache: Promise<TextToSVG> | null = null

export async function generateThumbnail(filePath: string, size: number): Promise<Buffer> {
  if ((await fs.stat(filePath)).size > maxThumbnailInputSize) {
    throw maxFileSizeExceededError()
  }
  // SVG must arrive as a buffer: sharp.block() above forbids VipsForeignLoadSvgFile
  // so librsvg gets no base directory for resolving local external resources.
  // `input` is reused by the metadata() probe below for exactly the same reason —
  // probing `filePath` would throw on every SVG.
  const input = path.extname(filePath).toLowerCase() === '.svg' ? await fs.readFile(filePath) : filePath
  // Fork: probe with metadata() before the resize. Format detection inside sharp
  // happens during pipeline execution; awaiting metadata() forces the format check
  // to fail here so callers get a normal rejected promise they can map to a 4xx
  // (instead of a stream error after headers were sent).
  //
  // Fork: returning a Buffer (via toBuffer()) instead of a stream is load-bearing
  // for HTTP delivery: a buffer has a known length, so the response can include
  // Content-Length. NC iOS' preview cache rejects responses without Content-Length
  // (it can't know the download is complete), which silently disables list-cell
  // thumbnails. Same fix applies to v2's grid view. The encoded bytes for a
  // 1024-px webp are tens of KB; buffering is cheap.
  await sharp(input, { failOn: 'none' }).metadata()
  return sharp(input, {
    failOn: 'none',
    sequentialRead: true, // sequential read = more efficient I/O
    limitInputPixels: 268e6 // protects against extremely large images
  })
    .rotate()
    .resize({
      width: size,
      height: size,
      fit: 'inside',
      kernel: 'nearest',
      withoutEnlargement: true,
      fastShrinkOnLoad: true // true by default, added for clarity
    })
    .webp({ quality: 80, effort: 0, alphaQuality: 90 })
    .toBuffer()
}

// Fork (#503): magic-byte sniff for the image formats sharp's prebuilt libvips
// commonly cannot decode. Returns the canonical `image/*` mime, or null.
//
// This gates the stream-the-original fallback. Two reasons it must be a sniff
// and not `getMimeType(path)`:
//
//  1. getMimeType is EXTENSION-based, so "any non-FileError decode failure"
//     let a non-image with an image extension through — a disguised SVG in a
//     `.png` was served verbatim as image/png, quietly undoing the rejection
//     image.spec.ts pins ("blocks file-mode rendering when SVG content is
//     disguised with another extension"). nosniff stops interpretation, but
//     serving the source at all is not the behaviour that test describes.
//  2. The interesting real case is the opposite mislabel — JPEG XL or HEIC
//     saved as `.jpg` — which only the bytes reveal.
//
// Deliberately narrow: a corrupt JPEG, a truncated PNG or a PDF renamed to
// .png all sniff as null and get the refusal, because no client can render
// those either.
export async function sniffUndecodableImageFormat(filePath: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    fh = await fs.open(filePath, 'r')
    const buf = Buffer.alloc(magicProbeBytes)
    const { bytesRead } = await fh.read(buf, 0, magicProbeBytes, 0)
    return sniffMagic(buf.subarray(0, bytesRead))
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => undefined)
  }
}

const magicProbeBytes = 16
// ISOBMFF major brands (bytes 8..12, after the `ftyp` box type at 4..8).
const isoBrandMimes: Record<string, string> = {
  heic: 'image/heic',
  heix: 'image/heic',
  hevc: 'image/heic',
  hevx: 'image/heic',
  heim: 'image/heic',
  heis: 'image/heic',
  mif1: 'image/heif',
  msf1: 'image/heif',
  avif: 'image/avif',
  avis: 'image/avif'
}

function sniffMagic(head: Buffer): string | null {
  // JPEG XL, naked codestream.
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0x0a) return 'image/jxl'
  // JPEG XL, ISOBMFF container: 12-byte signature box.
  if (head.length >= 12 && head.subarray(0, 12).toString('hex') === '0000000c4a584c200d0a870a') return 'image/jxl'
  // HEIC / HEIF / AVIF: `....ftyp<brand>`.
  if (head.length >= 12 && head.subarray(4, 8).toString('ascii') === 'ftyp') {
    return isoBrandMimes[head.subarray(8, 12).toString('ascii').toLowerCase()] ?? null
  }
  return null
}

export async function generateAvatar(initials: string): Promise<NodeJS.ReadableStream> {
  const tts = await getTextToSvg()
  const { backgroundColor, foregroundColor } = randomColor()
  const fontSize = fitFontSize(tts, initials, avatarSize * 0.67)

  const d = tts.getD(initials, {
    x: avatarSize / 2,
    y: avatarSize / 2.1,
    fontSize,
    anchor: 'center middle'
  })

  const svg = `
<svg width="${avatarSize}" height="${avatarSize}" viewBox="0 0 ${avatarSize} ${avatarSize}"
     xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="${backgroundColor}"/>
  <path d="${d}" fill="${foregroundColor}" />
</svg>`.trim()

  return sharp(Buffer.from(svg, 'utf8')).png()
}

export async function convertImageToBase64(imgPath: string) {
  const base64String = await fs.readFile(imgPath, { encoding: 'base64' })
  return `data:image/png;base64,${base64String}`
}

export async function convertTempImageToPng(temporaryImagePath: string, outputPngPath: string, size?: number): Promise<void> {
  size ??= avatarSize
  const srcBuffer = await fs.readFile(temporaryImagePath)
  const pngBuffer = await sharp(srcBuffer).rotate().resize(size, size, { fit: 'cover' }).png().toBuffer()
  await fs.writeFile(temporaryImagePath, pngBuffer)
  await moveFiles(temporaryImagePath, outputPngPath, true)
}

function randomColor() {
  let color = ''
  while (color.length < 6) {
    /* sometimes the returned value does not have
     * the 6 digits needed, so we do it again until
     * it does
     */
    color = Math.floor(Math.random() * 16777215).toString(16)
  }
  const red = parseInt(color.substring(0, 2), 16)
  const green = parseInt(color.substring(2, 4), 16)
  const blue = parseInt(color.substring(4, 6), 16)
  const brightness = red * 0.299 + green * 0.587 + blue * 0.114

  return {
    backgroundColor: `#${color}`,
    foregroundColor: brightness > 180 ? '#000000' : '#ffffff'
  }
}

function fitFontSize(tts: TextToSVG, text: string, box: number, start = box): number {
  // Heuristic for fitting text to the available width
  let size = Math.max(20, Math.floor(start))
  // Lower bound to prevent infinite loops when the font renders very small
  while (size > 20) {
    const m = tts.getMetrics(text, { fontSize: size, anchor: 'center middle' })
    if (m.width <= box) break
    size -= 4
  }
  return size
}

function getTextToSvg(): Promise<TextToSVG> {
  return (textToSvgCache ??= loadTextToSVG(fontPath) as Promise<TextToSVG>)
}
