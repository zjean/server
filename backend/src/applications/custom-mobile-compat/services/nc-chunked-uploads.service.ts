import { Injectable } from '@nestjs/common'
import * as fsSync from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { configuration } from '../../../configuration/config.environment'

// Chunked upload staging. NC protocol for big uploads:
//
//   MKCOL /remote.php/dav/uploads/{user}/{upload_id}
//   PUT   /remote.php/dav/uploads/{user}/{upload_id}/0
//   PUT   /remote.php/dav/uploads/{user}/{upload_id}/1
//   ...
//   MOVE  /remote.php/dav/uploads/{user}/{upload_id}/.file
//         → /remote.php/dav/files/{user}/<target>
//
// The .file destination virtual path is the signal to concatenate numbered
// parts (ordered by numeric suffix, not alphabetic) and MOVE into the user's
// files. Chunks live on disk under <dataDir>/nc-uploads/<user_id>/<upload_id>/.

// Convention name for the synthetic destination segment in the MOVE request.
// Different NC clients use different names; we accept both.
export const CHUNK_DEST_NAMES = ['.file', 'file'] as const

@Injectable()
export class NcChunkedUploadsService {
  private readonly root: string

  constructor() {
    // Resolve once at service init. If the path isn't writable later we'll
    // surface a 500 on the MKCOL — that's fine, this only runs in deployments
    // that actually use mobile uploads.
    this.root = resolveStagingRoot()
  }

  stagingDir(userId: number, uploadId: string): string {
    return path.join(this.root, String(userId), sanitize(uploadId))
  }

  chunkPath(userId: number, uploadId: string, chunkName: string): string {
    return path.join(this.stagingDir(userId, uploadId), sanitize(chunkName))
  }

  async ensureDir(userId: number, uploadId: string): Promise<void> {
    await fs.mkdir(this.stagingDir(userId, uploadId), { recursive: true })
  }

  exists(userId: number, uploadId: string): boolean {
    return fsSync.existsSync(this.stagingDir(userId, uploadId))
  }

  async writeChunk(userId: number, uploadId: string, chunkName: string, src: NodeJS.ReadableStream): Promise<number> {
    await this.ensureDir(userId, uploadId)
    const full = this.chunkPath(userId, uploadId, chunkName)
    const out = fsSync.createWriteStream(full)
    return new Promise((resolve, reject) => {
      let written = 0
      src.on('data', (c: Buffer | string) => (written += typeof c === 'string' ? Buffer.byteLength(c) : c.length))
      src.on('error', reject)
      out.on('error', reject)
      out.on('finish', () => resolve(written))
      src.pipe(out)
    })
  }

  async listChunks(userId: number, uploadId: string): Promise<string[]> {
    const dir = this.stagingDir(userId, uploadId)
    const entries = await fs.readdir(dir)
    // Sort by numeric prefix when possible ("10" > "2"), else lexicographic.
    return entries.sort((a, b) => {
      const an = Number.parseInt(a, 10)
      const bn = Number.parseInt(b, 10)
      if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn
      return a.localeCompare(b)
    })
  }

  // Same ordering as listChunks() plus size + mtime per entry. Used by the
  // upload-dir PROPFIND handler so Android's ChunkedFileUploadRemoteOperation
  // can compute `nextByte` (sum of getcontentlength values) and resume an
  // interrupted big-file upload instead of restarting from byte 0.
  //
  // stat() failures (race with a concurrent DELETE chunk, say) skip the
  // entry rather than failing the whole response — partial enumeration is
  // strictly better than 500-ing a PROPFIND mid-upload.
  async listChunksWithStats(userId: number, uploadId: string): Promise<{ name: string; size: number; mtimeMs: number }[]> {
    if (!this.exists(userId, uploadId)) return []
    const names = await this.listChunks(userId, uploadId)
    const out: { name: string; size: number; mtimeMs: number }[] = []
    for (const name of names) {
      try {
        const st = await fs.stat(this.chunkPath(userId, uploadId, name))
        if (!st.isFile()) continue
        out.push({ name, size: st.size, mtimeMs: st.mtimeMs })
      } catch {
        // chunk vanished between readdir and stat — skip
      }
    }
    return out
  }

  async concatenate(userId: number, uploadId: string, dest: string): Promise<number> {
    const parts = await this.listChunks(userId, uploadId)
    if (parts.length === 0) throw new Error('no chunks to assemble')
    await fs.mkdir(path.dirname(dest), { recursive: true })
    const out = fsSync.createWriteStream(dest)
    let total = 0
    try {
      for (const p of parts) {
        // Stream the chunk through with backpressure; never buffer the
        // whole part in memory. `{ end: false }` keeps the destination
        // open between chunks so we can pipe the next one in.
        const src = fsSync.createReadStream(this.chunkPath(userId, uploadId, p))
        src.on('data', (c: Buffer | string) => {
          total += typeof c === 'string' ? Buffer.byteLength(c) : c.length
        })
        await pipeline(src, out, { end: false })
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        out.on('error', reject)
        out.on('finish', () => resolve())
        out.end()
      })
    }
    return total
  }

  async remove(userId: number, uploadId: string): Promise<void> {
    await fs.rm(this.stagingDir(userId, uploadId), { recursive: true, force: true })
  }

  // Test hook: override the staging root. Only called by unit tests.
  __setRootForTests(root: string): void {
    ;(this as unknown as { root: string }).root = root
  }
}

function sanitize(segment: string): string {
  // Disallow path separators and dot-dot. Everything else is fine because the
  // segment is owned by our own naming scheme (upload_id is generated by the
  // client but we never expand it further than a leaf).
  return segment.replace(/[/\\]/g, '_').replace(/\.\.+/g, '_')
}

function resolveStagingRoot(): string {
  // Prefer the configured data dir. Fallback to os-tempdir if config doesn't
  // expose one — acceptable for tests; production always has dataDir set.
  const cfg = (configuration as unknown as { applications?: { files?: { dataPath?: string } } }).applications?.files?.dataPath
  const base = cfg ?? path.join(process.cwd(), 'data')
  return path.join(base, 'nc-uploads')
}
