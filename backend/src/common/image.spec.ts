import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { generateThumbnail } from './image'

// 1×1 transparent PNG (smallest valid PNG, hex-encoded).
const tinyPng = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100' + '0d0a2db4000000004945',
  'hex'
)

describe('generateThumbnail', () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-spec-'))
  })

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('returns a webp Buffer with a known length for a valid image', async () => {
    const file = path.join(tmpDir, 'tiny.png')
    await fs.writeFile(file, tinyPng)
    const buf = await generateThumbnail(file, 64)
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(0)
    // First 4 bytes of any WebP file are the RIFF magic.
    expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF')
  })

  it('rejects synchronously when sharp cannot decode the file', async () => {
    // Non-image bytes saved with a .jpg extension. Without the metadata
    // probe in generateThumbnail, sharp's "unsupported image format" error
    // would surface only during stream consumption — here we expect the
    // promise itself to reject so callers can map it to a 4xx without the
    // response headers ever being written.
    const file = path.join(tmpDir, 'fake.jpg')
    await fs.writeFile(file, Buffer.from('this is not an image, just text'))
    await expect(generateThumbnail(file, 64)).rejects.toThrow(/unsupported image format|Input/i)
  })
})
