import { mkdtemp, open, rm, truncate, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { maxFileSizeExceededError } from '../applications/files/utils/errors'
import {
  generateThumbnail,
  maxThumbnailFallbackSize,
  maxThumbnailInputSize,
  sniffUndecodableImageFormat,
  sniffUndecodableImageFormatFromHandle
} from './image'

// 1×1 transparent PNG (smallest valid PNG, hex-encoded).
const tinyPng = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100' + '0d0a2db4000000004945',
  'hex'
)

describe(generateThumbnail.name, () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'thumbnail-svg-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  // Fork: the return type is a Buffer, not a stream, so the response can carry
  // Content-Length (NC iOS' preview cache requires it). See common/image.ts.
  it('returns a webp Buffer with a known length for a valid image', async () => {
    const file = path.join(tmpDir, 'tiny.png')
    await writeFile(file, tinyPng)

    const buf = await generateThumbnail(file, 64)

    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(0)
    // First 4 bytes of any WebP file are the RIFF magic.
    expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF')
  })

  // Fork: without the metadata() probe, sharp's "unsupported image format" error
  // would surface only during stream consumption — i.e. after response headers
  // were written. Callers need the promise itself to reject so they can map it
  // to a 4xx.
  it('rejects before returning when sharp cannot decode the file', async () => {
    const file = path.join(tmpDir, 'fake.jpg')
    await writeFile(file, Buffer.from('this is not an image, just text'))

    await expect(generateThumbnail(file, 64)).rejects.toThrow(/unsupported image format|Input/i)
  })

  it('generates a WebP thumbnail from an SVG', async () => {
    const svgPath = path.join(tmpDir, 'image.svg')
    await writeFile(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="blue"/></svg>')

    const thumbnail = await generateThumbnail(svgPath, 32)

    await expect(sharp(thumbnail).metadata()).resolves.toMatchObject({ format: 'webp', width: 32, height: 32 })
  })

  it.each(['png', 'svg'])('rejects an oversized %s source before rendering', async (extension) => {
    const imagePath = path.join(tmpDir, `oversized.${extension}`)
    await writeFile(imagePath, '')
    await truncate(imagePath, maxThumbnailInputSize + 1)

    await expect(generateThumbnail(imagePath, 32)).rejects.toEqual(maxFileSizeExceededError())
  })

  it.each([
    ['XInclude', (secretPath: string) => `<xi:include href="${path.basename(secretPath)}"/>`],
    ['relative image xlink:href', (secretPath: string) => `<image xlink:href="${path.basename(secretPath)}" width="32" height="32"/>`],
    ['file image xlink:href', (secretPath: string) => `<image xlink:href="${pathToFileURL(secretPath).href}" width="32" height="32"/>`]
  ])('does not render local resources referenced through %s', async (_name, externalElement) => {
    const secretPath = path.join(tmpDir, 'secret.svg')
    const svgPath = path.join(tmpDir, 'image.svg')
    await writeFile(secretPath, '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red"/></svg>')
    await writeFile(
      svgPath,
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xi="http://www.w3.org/2001/XInclude" xmlns:xlink="http://www.w3.org/1999/xlink"
        width="32" height="32">
        <rect width="32" height="32" fill="blue"/>
        ${externalElement(secretPath)}
      </svg>`
    )

    const thumbnail = await generateThumbnail(svgPath, 32)
    const pixel = await sharp(thumbnail).removeAlpha().extract({ left: 16, top: 16, width: 1, height: 1 }).raw().toBuffer()

    expect(pixel[0]).toBeLessThan(50)
    expect(pixel[2]).toBeGreaterThan(200)
  })

  it('blocks file-mode rendering when SVG content is disguised with another extension', async () => {
    const disguisedSvgPath = path.join(tmpDir, 'image.png')
    await writeFile(disguisedSvgPath, '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32"/></svg>')

    // The Buffer return means this now rejects from the call itself rather than
    // during stream consumption — upstream needed an async IIFE here.
    await expect(generateThumbnail(disguisedSvgPath, 32)).rejects.toThrow()
  })
})

// Fork (#503): gate for FilesManager.generateThumbnail's "sharp cannot decode
// this — stream the original" fallback. The point of sniffing rather than
// trusting the extension is that BOTH mislabel directions are real: a HEIC
// saved as .jpg (must fall back) and an SVG saved as .png (must not).
describe(sniffUndecodableImageFormat.name, () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'thumbnail-sniff-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  async function write(name: string, bytes: Buffer | string): Promise<string> {
    const file = path.join(tmpDir, name)
    await writeFile(file, bytes)
    return file
  }

  // `....ftyp<brand>` — the ISO base media container both HEIC and AVIF use.
  function isobmff(brand: string): Buffer {
    return Buffer.concat([Buffer.from('00000018', 'hex'), Buffer.from('ftyp', 'ascii'), Buffer.from(brand, 'ascii'), Buffer.alloc(8)])
  }

  it.each([
    ['heic', 'image/heic'],
    ['heix', 'image/heic'],
    ['mif1', 'image/heif'],
    ['avif', 'image/avif'],
    ['avis', 'image/avif']
  ])('recognises the ISOBMFF brand %s as %s', async (brand, mime) => {
    // Extension deliberately wrong — the whole point is that bytes win.
    expect(await sniffUndecodableImageFormat(await write(`photo-${brand}.jpg`, isobmff(brand)))).toBe(mime)
  })

  // Fork (#503 review): BMP and ICO are the SILENT half of the allow-list.
  // `.bmp`/`.ico` pass FilesManager's `startsWith('image-')` gate, sharp has no
  // libvips loader for either (`sharp.format.bmp` and `.ico` are both absent in
  // 8.18.6), and every browser renders them — so leaving them off the list
  // turned working previews into generic file icons with no error anywhere.
  function bmp(dibHeaderSize: number): Buffer {
    const buf = Buffer.alloc(32)
    buf.write('BM', 0, 'ascii')
    buf.writeUInt32LE(32, 2) // file size
    buf.writeUInt32LE(0, 6) // reserved
    buf.writeUInt32LE(14 + dibHeaderSize, 10) // pixel data offset
    buf.writeUInt32LE(dibHeaderSize, 14)
    return buf
  }

  // ICONDIR: reserved uint16 0, type uint16 1, image count uint16.
  function ico(type: number, count: number): Buffer {
    const buf = Buffer.alloc(22)
    buf.writeUInt16LE(0, 0)
    buf.writeUInt16LE(type, 2)
    buf.writeUInt16LE(count, 4)
    return buf
  }

  it.each([
    ['BITMAPCOREHEADER', 12],
    ['BITMAPINFOHEADER', 40],
    ['BITMAPV4HEADER', 108],
    ['BITMAPV5HEADER', 124]
  ])('recognises a BMP declaring a %s', async (_label, dibHeaderSize) => {
    // Extension deliberately wrong again — bytes win.
    expect(await sniffUndecodableImageFormat(await write(`shot-${dibHeaderSize}.png`, bmp(dibHeaderSize)))).toBe('image/bmp')
  })

  it('does not take "BM" alone as a BMP', async () => {
    // Two bytes of magic is far too weak on its own: the DIB header size at
    // offset 14 is what makes this a signature rather than a prefix match.
    expect(await sniffUndecodableImageFormat(await write('note.bmp', Buffer.from('BMX text that happens to start with BM')))).toBeNull()
  })

  it('recognises an ICO', async () => {
    expect(await sniffUndecodableImageFormat(await write('favicon.ico', ico(1, 3)))).toBe('image/vnd.microsoft.icon')
  })

  it.each([
    ['a .cur cursor (ICONDIR type 2)', ico(2, 1)],
    ['an ICONDIR declaring no images', ico(1, 0)]
  ])('returns null for %s', async (_label, bytes) => {
    expect(await sniffUndecodableImageFormat(await write('thing.ico', bytes))).toBeNull()
  })

  it('recognises a naked JPEG XL codestream', async () => {
    expect(await sniffUndecodableImageFormat(await write('shot.jpg', Buffer.from('ff0a' + '00'.repeat(14), 'hex')))).toBe('image/jxl')
  })

  it('recognises a JPEG XL ISOBMFF signature box', async () => {
    expect(await sniffUndecodableImageFormat(await write('shot.jxl', Buffer.from('0000000c4a584c200d0a870a' + '00'.repeat(4), 'hex')))).toBe(
      'image/jxl'
    )
  })

  it.each([
    ['a real PNG', 'real.png', tinyPng],
    ['an SVG disguised as a PNG', 'disguised.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"></svg>')],
    ['a JPEG', 'photo.jpg', Buffer.from('ffd8ffe000104a46494600' + '00'.repeat(8), 'hex')],
    ['a PDF renamed to .png', 'doc.png', Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')],
    ['an unknown ISOBMFF brand', 'clip.png', isobmff('mp42')],
    ['an empty file', 'empty.png', Buffer.alloc(0)],
    ['a file too short to carry any signature', 'stub.png', Buffer.from('ff', 'hex')]
  ])('returns null for %s', async (_label, name, bytes) => {
    expect(await sniffUndecodableImageFormat(await write(name, bytes))).toBeNull()
  })

  it('returns null rather than throwing when the file is gone', async () => {
    expect(await sniffUndecodableImageFormat(path.join(tmpDir, 'does-not-exist.heic'))).toBeNull()
  })

  // Fork (#503 review): the handle-taking variant is what FilesManager calls,
  // so that the sniff and the bytes it then serves come from ONE descriptor
  // (invariant 3). It must agree with the path form and must leave the
  // handle's file position alone, or the caller's createReadStream would skip
  // the header it just read.
  describe(sniffUndecodableImageFormatFromHandle.name, () => {
    it('agrees with the path form and leaves the read position at 0', async () => {
      const bytes = Buffer.concat([isobmff('heic'), Buffer.from('trailing payload')])
      const fh = await open(await write('pinned.jpg', bytes), 'r')
      try {
        expect(await sniffUndecodableImageFormatFromHandle(fh)).toBe('image/heic')
        const chunks: Buffer[] = []
        for await (const chunk of fh.createReadStream({ start: 0, autoClose: false })) {
          chunks.push(chunk as Buffer)
        }
        expect(Buffer.concat(chunks).equals(bytes)).toBe(true)
      } finally {
        await fh.close()
      }
    })

    it('returns null rather than throwing on a closed handle', async () => {
      const fh = await open(await write('closed.heic', isobmff('heic')), 'r')
      await fh.close()
      expect(await sniffUndecodableImageFormatFromHandle(fh)).toBeNull()
    })
  })

  // The fallback ceiling must stay well under the decode ceiling: one bounds
  // what we DECODE (answer is a tens-of-KB webp), the other what we SEND
  // VERBATIM, once per grid tile.
  it('caps the fallback far below the decode input cap', () => {
    expect(maxThumbnailFallbackSize).toBeLessThan(maxThumbnailInputSize)
  })
})
