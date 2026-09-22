// Every fs.WriteStream the service opens is recorded, so the abort case can
// assert the descriptor was actually released rather than merely that the
// promise rejected. vi.spyOn cannot do this — the `node:fs` namespace object is
// read-only — so the module is wrapped instead, keeping every other export real.
const writeStreamSpy = vi.hoisted(() => ({ created: [] as import('node:fs').WriteStream[] }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    default: actual,
    createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => {
      const ws = actual.createWriteStream(...args)
      writeStreamSpy.created.push(ws)
      return ws
    }
  }
})

import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { NcChunkedUploadsService, sanitizeUploadId } from './nc-chunked-uploads.service'

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

    // The abort-mid-upload case is the NORMAL one on mobile, and `src.pipe(out)`
    // does not destroy `out` when `src` errors: the descriptor stayed open for
    // the life of the process and a short chunk was left on disk, which would
    // then poison Android's resume arithmetic (listChunksWithStats sums chunk
    // sizes to derive `nextByte`).
    describe('when the client aborts mid-chunk', () => {
      beforeEach(() => {
        writeStreamSpy.created.length = 0
      })

      it('rejects, destroys the write stream, and removes the partial file', async () => {
        // The failure is driven from inside `_read` rather than off a timer:
        // one chunk goes through, the next read aborts. A timer made this case
        // load-dependent and it surfaced as an intermittent unhandled error in
        // the full suite.
        let pushed = false
        const src = new Readable({
          read() {
            if (!pushed) {
              pushed = true
              this.push(Buffer.from('half a chunk'))
              return
            }
            this.destroy(new Error('client aborted'))
          }
        })

        await expect(svc.writeChunk(USER, UPLOAD, '0', src)).rejects.toThrow('client aborted')

        expect(writeStreamSpy.created).toHaveLength(1)
        expect(writeStreamSpy.created[0].destroyed).toBe(true)
        expect(writeStreamSpy.created[0].closed).toBe(true)
        expect(fs.existsSync(svc.chunkPath(USER, UPLOAD, '0'))).toBe(false)
      })
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

  describe('listChunksWithStats', () => {
    it('returns name + size + mtimeMs per chunk, in numeric order', async () => {
      await svc.ensureDir(USER, UPLOAD)
      const payloads: Record<string, Buffer> = {
        '0': Buffer.alloc(1024),
        '1': Buffer.alloc(2048),
        '10': Buffer.alloc(512)
      }
      for (const [name, buf] of Object.entries(payloads)) {
        await fsp.writeFile(svc.chunkPath(USER, UPLOAD, name), buf)
      }
      const stats = await svc.listChunksWithStats(USER, UPLOAD)
      expect(stats.map((s) => s.name)).toEqual(['0', '1', '10'])
      expect(stats.map((s) => s.size)).toEqual([1024, 2048, 512])
      for (const s of stats) {
        expect(s.mtimeMs).toBeGreaterThan(0)
      }
    })

    it('returns [] when the staging dir does not exist (pre-MKCOL probe)', async () => {
      // Important: do NOT throw. Android may PROPFIND before MKCOL during
      // a fresh retry; a 500/exception would break the resume flow entirely.
      const stats = await svc.listChunksWithStats(USER, 'never-created')
      expect(stats).toEqual([])
    })

    it('skips entries that vanish between readdir and stat', async () => {
      // Simulate by creating a directory entry (not a regular file) — stat
      // will succeed but isFile() returns false, exercising the same skip
      // branch a race-removed entry takes.
      await svc.ensureDir(USER, UPLOAD)
      await fsp.writeFile(svc.chunkPath(USER, UPLOAD, '0'), 'real chunk')
      await fsp.mkdir(svc.chunkPath(USER, UPLOAD, 'subdir'))
      const stats = await svc.listChunksWithStats(USER, UPLOAD)
      expect(stats.map((s) => s.name)).toEqual(['0'])
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

    // #485's open question: when `pipeline` rejects it destroys `out`, and the
    // `finally` then attaches handlers and calls `out.end()` on an already
    // destroyed writable. If `end()` stayed silent the promise would never
    // settle and the MOVE would hang forever. It does not — but that was
    // unverified, so pin it with a timeout rather than re-derive it.
    it('rejects (does not hang) when the destination cannot be written', async () => {
      await svc.ensureDir(USER, UPLOAD)
      await fsp.writeFile(svc.chunkPath(USER, UPLOAD, '0'), 'AAA')
      // A directory where the destination file should go: mkdir(dirname) still
      // succeeds, and the open() behind createWriteStream fails with EISDIR.
      const dest = path.join(tmpRoot, 'out', 'blocked.bin')
      await fsp.mkdir(dest, { recursive: true })

      await expect(svc.concatenate(USER, UPLOAD, dest)).rejects.toThrow()
    }, 5000)

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

// `uploadId` is a route param and reaches the filesystem from two places: the
// staging paths in this service (which always sanitised it) and the assembly
// tmp path in nc-uploads.controller (which did not). That asymmetry was an
// authenticated arbitrary-file-truncation primitive: a `..`-laden id escaped
// the user's tree, recursive mkdir materialised the odd intermediate directory
// so the kernel's `..` resolution succeeded, and the destination was opened
// with 'w'. These pin the sanitiser that both sides now share.
describe('sanitizeUploadId', () => {
  it('neutralises a plain dot-dot traversal', () => {
    expect(sanitizeUploadId('../../../../etc/evil')).not.toContain('..')
    expect(sanitizeUploadId('../../../../etc/evil')).not.toContain('/')
  })

  it('neutralises the percent-decoded form the router hands us', () => {
    // find-my-way decodes %2F → / and %2E → . in path params, so by the time a
    // handler sees the id the encoding is already gone. Sanitising the encoded
    // spelling instead of the decoded one would be a no-op.
    const decoded = decodeURIComponent('%2E%2E%2F%2E%2E%2Fetc%2Fevil')
    expect(decoded).toBe('../../etc/evil')
    expect(sanitizeUploadId(decoded)).not.toContain('..')
    expect(sanitizeUploadId(decoded)).not.toContain('/')
  })

  it('neutralises backslash separators too', () => {
    expect(sanitizeUploadId('..\\..\\windows')).not.toContain('\\')
    expect(sanitizeUploadId('..\\..\\windows')).not.toContain('..')
  })

  it('collapses runs of dots, not just pairs', () => {
    expect(sanitizeUploadId('....//....//x')).not.toContain('.')
  })

  it('leaves a real NC upload id untouched', () => {
    // Stock clients send a numeric-ish id; mangling it would break uploads.
    expect(sanitizeUploadId('web-file-upload-abc123-1700000000')).toBe('web-file-upload-abc123-1700000000')
    expect(sanitizeUploadId('2147483647')).toBe('2147483647')
  })

  it('keeps a single dot, which is legal inside an id', () => {
    expect(sanitizeUploadId('upload.1')).toBe('upload.1')
  })
})
