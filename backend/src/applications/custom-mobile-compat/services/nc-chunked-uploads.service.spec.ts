import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { NcChunkedUploadsService } from './nc-chunked-uploads.service'

describe(NcChunkedUploadsService.name, () => {
  let svc: NcChunkedUploadsService
  let tmpRoot: string
  const USER = 42
  const UPLOAD = 'upload-abc'

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-chunked-'))
    svc = new NcChunkedUploadsService()
    svc.__setRootForTests(tmpRoot)
  })

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true })
  })

  describe('path composition', () => {
    it('stagingDir composes as <root>/<userId>/<uploadId>', () => {
      expect(svc.stagingDir(USER, UPLOAD)).toBe(path.join(tmpRoot, String(USER), UPLOAD))
    })

    it('chunkPath composes as <stagingDir>/<chunkName>', () => {
      expect(svc.chunkPath(USER, UPLOAD, '0')).toBe(path.join(tmpRoot, String(USER), UPLOAD, '0'))
    })

    it('sanitize neutralizes path separators and ".." in stagingDir', () => {
      // Implementation: first replaces "/" with "_", then collapses runs of
      // "..+" dots into a single "_". "../foo" → ".._foo" → "__foo".
      // The defense-in-depth property we care about: no "/" or ".." escapes
      // past this layer.
      const out = svc.stagingDir(USER, '../foo')
      expect(out).toBe(path.join(tmpRoot, String(USER), '__foo'))
      expect(out).not.toMatch(/\.\./)
      expect(out.split(path.sep).pop()).not.toContain('/')
    })

    it('sanitize rejects embedded slashes in chunk name ("a/b" → "a_b")', () => {
      expect(svc.chunkPath(USER, UPLOAD, 'a/b')).toBe(path.join(tmpRoot, String(USER), UPLOAD, 'a_b'))
    })
  })

  describe('ensureDir', () => {
    it('creates intermediate directories', async () => {
      await svc.ensureDir(USER, UPLOAD)
      const st = await fsp.stat(svc.stagingDir(USER, UPLOAD))
      expect(st.isDirectory()).toBe(true)
    })

    it('is idempotent', async () => {
      await svc.ensureDir(USER, UPLOAD)
      await expect(svc.ensureDir(USER, UPLOAD)).resolves.toBeUndefined()
    })
  })

  describe('exists', () => {
    it('returns false before the dir is created, true after', async () => {
      expect(svc.exists(USER, UPLOAD)).toBe(false)
      await svc.ensureDir(USER, UPLOAD)
      expect(svc.exists(USER, UPLOAD)).toBe(true)
    })
  })

  describe('writeChunk', () => {
    it('streams a buffer to disk and returns bytes written', async () => {
      const payload = Buffer.from('hello chunked world')
      const n = await svc.writeChunk(USER, UPLOAD, '0', Readable.from(payload))
      expect(n).toBe(payload.length)
      const on_disk = await fsp.readFile(svc.chunkPath(USER, UPLOAD, '0'))
      expect(on_disk.equals(payload)).toBe(true)
    })
  })

  describe('listChunks', () => {
    it('sorts numerically, not alphabetically', async () => {
      await svc.ensureDir(USER, UPLOAD)
      for (const name of ['10', '2', '0', '1']) {
        await fsp.writeFile(svc.chunkPath(USER, UPLOAD, name), name)
      }
      const parts = await svc.listChunks(USER, UPLOAD)
      expect(parts).toEqual(['0', '1', '2', '10'])
    })

    it('falls back to lexicographic for non-numeric names', async () => {
      await svc.ensureDir(USER, UPLOAD)
      for (const name of ['b', 'a', 'c']) {
        await fsp.writeFile(svc.chunkPath(USER, UPLOAD, name), name)
      }
      const parts = await svc.listChunks(USER, UPLOAD)
      expect(parts).toEqual(['a', 'b', 'c'])
    })
  })

  describe('concatenate', () => {
    it('writes all chunks in numeric order into the target file', async () => {
      const chunks = {
        '0': Buffer.from('AAA'),
        '1': Buffer.from('BBBB'),
        '2': Buffer.from('CC'),
        '10': Buffer.from('end')
      }
      await svc.ensureDir(USER, UPLOAD)
      for (const [name, buf] of Object.entries(chunks)) {
        await fsp.writeFile(svc.chunkPath(USER, UPLOAD, name), buf)
      }
      const dest = path.join(tmpRoot, 'out', 'final.bin')
      const total = await svc.concatenate(USER, UPLOAD, dest)
      const expected = Buffer.concat([chunks['0'], chunks['1'], chunks['2'], chunks['10']])
      expect(total).toBe(expected.length)
      const actual = await fsp.readFile(dest)
      expect(actual.equals(expected)).toBe(true)
    })

    it('throws when there are no chunks', async () => {
      await svc.ensureDir(USER, UPLOAD)
      const dest = path.join(tmpRoot, 'out', 'empty.bin')
      await expect(svc.concatenate(USER, UPLOAD, dest)).rejects.toThrow('no chunks to assemble')
    })

    it('produces a byte-identical result for chunks larger than the write-stream high-water mark', async () => {
      // The previous implementation buffered each chunk fully in memory via
      // fs.readFile + out.write(data) — sidestepping backpressure on the
      // destination. Switching to stream.pipeline with `{ end: false }` keeps
      // peak memory bounded but the assembled output must still match.
      // Pick chunk sizes well above the default 64KB high-water mark so the
      // streaming path actually has to drain.
      const chunkSize = 256 * 1024 // 256 KiB
      const chunks: Record<string, Buffer> = {}
      for (let i = 0; i < 4; i++) {
        const buf = Buffer.alloc(chunkSize)
        buf.fill(`abcd`.charCodeAt(i))
        chunks[String(i)] = buf
      }
      await svc.ensureDir(USER, UPLOAD)
      for (const [name, buf] of Object.entries(chunks)) {
        await fsp.writeFile(svc.chunkPath(USER, UPLOAD, name), buf)
      }
      const dest = path.join(tmpRoot, 'out', 'big.bin')
      const total = await svc.concatenate(USER, UPLOAD, dest)
      const expected = Buffer.concat([chunks['0'], chunks['1'], chunks['2'], chunks['3']])
      expect(total).toBe(expected.length)
      const actual = await fsp.readFile(dest)
      expect(actual.equals(expected)).toBe(true)
    })
  })

  describe('remove', () => {
    it('deletes the staging directory', async () => {
      await svc.ensureDir(USER, UPLOAD)
      await fsp.writeFile(svc.chunkPath(USER, UPLOAD, '0'), 'x')
      expect(svc.exists(USER, UPLOAD)).toBe(true)
      await svc.remove(USER, UPLOAD)
      expect(svc.exists(USER, UPLOAD)).toBe(false)
    })

    it('is a no-op when the dir does not exist', async () => {
      await expect(svc.remove(USER, 'never-created')).resolves.toBeUndefined()
    })
  })
})
