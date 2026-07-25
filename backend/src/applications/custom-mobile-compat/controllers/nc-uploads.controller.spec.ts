import * as filesUtils from '../../files/utils/files'
import { buildUploadDirPropfindBody, NcUploadsController, parseOcTotalLength } from './nc-uploads.controller'

// OC-Total-Length is part of the NC chunked-upload protocol — clients are
// expected to send it on the assembly MOVE, but Android NextcloudKit may
// omit it on the chunked path (audit U1 hypothesis). We accept the header
// as optional but verify equality when present. The parse helper centralizes
// the "is the client telling us how much they uploaded?" decision so the
// controller's main path stays linear.
describe('parseOcTotalLength', () => {
  it('returns the integer value for a well-formed positive header', () => {
    expect(parseOcTotalLength('1024')).toBe(1024)
  })

  it('returns null for an absent header', () => {
    expect(parseOcTotalLength(undefined)).toBeNull()
  })

  it('returns null for the empty string', () => {
    expect(parseOcTotalLength('')).toBeNull()
  })

  it('returns null for a non-numeric header', () => {
    expect(parseOcTotalLength('not-a-number')).toBeNull()
  })

  it('returns null for zero (no zero-byte upload assembly)', () => {
    expect(parseOcTotalLength('0')).toBeNull()
  })

  it('returns null for a negative number', () => {
    expect(parseOcTotalLength('-1')).toBeNull()
  })

  // Fastify exposes repeated headers as a string[]; for our purposes we
  // honor the first value and ignore any duplicates. Real clients won't
  // send the header twice — this is defensive.
  it('parses the first element when an array is passed', () => {
    expect(parseOcTotalLength(['2048', 'ignored'])).toBe(2048)
  })
})

// Audit #6: Android's ChunkedFileUploadRemoteOperation does PROPFIND depth 1
// on /remote.php/dav/uploads/<user>/<uploadId> to enumerate already-uploaded
// chunks (sums each <d:getcontentlength> to compute nextByte). Before this
// fix our PROPFIND only emitted the collection response — Android decided
// "no chunks yet" and re-uploaded the whole file from byte 0 on every retry.
// The helper builds the multistatus body the controller emits.
describe('buildUploadDirPropfindBody', () => {
  const baseHref = '/remote.php/dav/uploads/alice/abc123'

  it('returns just the collection response when no chunks are listed (initial probe)', () => {
    const body = buildUploadDirPropfindBody(baseHref, [])
    expect(body).toContain('<?xml version="1.0" encoding="utf-8"?>')
    expect(body).toContain('<d:multistatus xmlns:d="DAV:">')
    // Exactly one <d:response> — the collection itself.
    expect(body.match(/<d:response>/g)?.length).toBe(1)
    expect(body).toContain(`<d:href>${baseHref}</d:href>`)
    expect(body).toContain('<d:resourcetype><d:collection/></d:resourcetype>')
  })

  it('emits a per-chunk <d:response> in addition to the collection one', () => {
    const body = buildUploadDirPropfindBody(baseHref, [
      { name: '0', size: 1048576, mtimeMs: 1716220800000 }, // 2024-05-20T16:00:00Z-ish
      { name: '1', size: 524288, mtimeMs: 1716220860000 }
    ])
    // 1 collection + 2 chunks = 3 responses
    expect(body.match(/<d:response>/g)?.length).toBe(3)
    expect(body).toContain(`<d:href>${baseHref}/0</d:href>`)
    expect(body).toContain(`<d:href>${baseHref}/1</d:href>`)
    expect(body).toContain('<d:getcontentlength>1048576</d:getcontentlength>')
    expect(body).toContain('<d:getcontentlength>524288</d:getcontentlength>')
    // Chunks are files, not collections — resourcetype must be empty.
    const chunkSegment = body.split(`<d:href>${baseHref}/0</d:href>`)[1].split('</d:response>')[0]
    expect(chunkSegment).toContain('<d:resourcetype/>')
    expect(chunkSegment).not.toContain('<d:collection/>')
  })

  it('emits RFC 1123 getlastmodified for each chunk', () => {
    const body = buildUploadDirPropfindBody(baseHref, [
      { name: '0', size: 100, mtimeMs: Date.UTC(2024, 4, 20, 16, 0, 0) } // 2024-05-20T16:00:00Z
    ])
    // RFC 1123 format: "Mon, 20 May 2024 16:00:00 GMT"
    expect(body).toContain('<d:getlastmodified>Mon, 20 May 2024 16:00:00 GMT</d:getlastmodified>')
  })

  it('URL-encodes chunk names containing reserved characters', () => {
    // Real NC clients name chunks numerically, but defense-in-depth: ensure a
    // chunk name with a space or unicode char becomes a well-formed href.
    const body = buildUploadDirPropfindBody(baseHref, [
      { name: 'part one', size: 100, mtimeMs: 0 },
      { name: 'résumé', size: 200, mtimeMs: 0 }
    ])
    expect(body).toContain(`<d:href>${baseHref}/part%20one</d:href>`)
    expect(body).toContain(`<d:href>${baseHref}/r%C3%A9sum%C3%A9</d:href>`)
  })

  it('escapes XML metacharacters in the parent href', () => {
    // A pathological upload id with an ampersand — sanitize() in the service
    // replaces / and .., but '&' would pass through if unescaped.
    const body = buildUploadDirPropfindBody('/remote.php/dav/uploads/alice/A&B', [])
    expect(body).toContain('<d:href>/remote.php/dav/uploads/alice/A&amp;B</d:href>')
    expect(body).not.toContain('<d:href>/remote.php/dav/uploads/alice/A&B</d:href>')
  })
})

// Fork: versioning hook on the assembly MOVE.
//
// NC chunked uploads bypass saveStream entirely — they assemble chunks to a
// sibling tmp file and moveFiles it into place — so without a hook here every
// large-file overwrite from an NC mobile client would be unversioned. This is
// the only unit coverage of the controller itself; the rest of this file
// exercises the pure helpers.
describe('NcUploadsController assembly versioning', () => {
  const user = { id: 7, login: 'alice' } as any

  function buildController(destinationExists: boolean) {
    const versioning = { snapshotBeforeOverwrite: vi.fn().mockResolvedValue(undefined) }
    const space = {
      realPath: '/data/users/alice/files/big.zip',
      dbFile: { ownerId: 7, path: 'big.zip', inTrash: false },
      envPermissions: 'a:m:d',
      url: 'files/personal/big.zip'
    }
    const staging = {
      concatenate: vi.fn().mockResolvedValue(1024),
      remove: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockReturnValue(true),
      ensureDir: vi.fn()
    }
    const resolver = { resolve: vi.fn().mockReturnValue({ repository: 'files', spaceAlias: 'personal', relativePath: 'big.zip' }) }
    const spacesManager = { spaceEnv: vi.fn().mockResolvedValue(space) }

    vi.spyOn(filesUtils, 'isPathExists').mockResolvedValue(destinationExists)
    vi.spyOn(filesUtils, 'makeDir').mockResolvedValue('' as any)
    vi.spyOn(filesUtils, 'moveFiles').mockResolvedValue(undefined)

    const controller = new NcUploadsController(staging as any, resolver as any, spacesManager as any, versioning as any)
    return { controller, versioning, space }
  }

  const moveReq = () =>
    ({
      user,
      method: 'MOVE',
      url: '/remote.php/dav/uploads/alice/up-1/.file',
      headers: { destination: '/remote.php/dav/files/alice/big.zip', 'oc-total-length': '1024' }
    }) as any

  const res = () => ({ status: vi.fn().mockReturnThis(), header: vi.fn().mockReturnThis(), send: vi.fn() }) as any

  afterEach(() => vi.restoreAllMocks())

  it('snapshots the existing destination before the assembly move, tagged nc-chunked', async () => {
    const { controller, versioning, space } = buildController(true)

    await controller.chunkHandler('alice', 'up-1', moveReq(), res())

    expect(versioning.snapshotBeforeOverwrite).toHaveBeenCalledTimes(1)
    expect(versioning.snapshotBeforeOverwrite).toHaveBeenCalledWith(user, space, { origin: 'nc-chunked' })
    expect(versioning.snapshotBeforeOverwrite.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(filesUtils.moveFiles).mock.invocationCallOrder[0])
  })

  it('does not snapshot when the upload creates a new file', async () => {
    const { controller, versioning } = buildController(false)

    await controller.chunkHandler('alice', 'up-1', moveReq(), res())

    expect(versioning.snapshotBeforeOverwrite).not.toHaveBeenCalled()
    expect(filesUtils.moveFiles).toHaveBeenCalled()
  })
})
