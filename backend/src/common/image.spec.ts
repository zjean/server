import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { maxFileSizeExceededError } from '../applications/files/utils/errors'
import { generateThumbnail, maxThumbnailInputSize } from './image'

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
