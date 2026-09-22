import * as filesUtils from '../../files/utils/files'
import { NcPathResolverService } from '../services/nc-path-resolver.service'
import { buildUploadDirPropfindBody, NcUploadsController, parseOcTotalLength } from './nc-uploads.controller'

// The share-mount resolver the assembly Destination is now routed through
// (#516). Most cases here have no incoming shares, so the default is empty.
const noMounts = (mounts: { alias: string }[] = []) => ({ listMounts: vi.fn().mockResolvedValue(mounts) })

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
    // Explicitly closed, not self-closed: the shared builder runs with
    // suppressEmptyNode: false, matching every other body in this module.
    expect(body).toContain('<d:resourcetype><d:collection></d:collection></d:resourcetype>')
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
    // Chunks are files, not collections — resourcetype must be an EMPTY
    // element. Android's WebdavEntry turns ANY non-null resourcetype value into
    // contentType "DIR", and a chunk read as a directory has no size to sum for
    // the resume offset. `<d:resourcetype></d:resourcetype>` and
    // `<d:resourcetype/>` are both empty; the former is what the shared builder
    // emits and what the rest of this module has always emitted.
    const chunkSegment = body.split(`<d:href>${baseHref}/0</d:href>`)[1].split('</d:response>')[0]
    expect(chunkSegment).toContain('<d:resourcetype></d:resourcetype>')
    expect(chunkSegment).not.toContain('d:collection')
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

    const controller = new NcUploadsController(staging as any, resolver as any, noMounts() as any, spacesManager as any, versioning as any)
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

// The assembly MOVE's Destination header, end to end through the real path
// resolver. Two defects lived here:
//
//   #484 — parseDestination did its own decodeURIComponent and then handed the
//          result to resolve(), whose normalize() decodes again. A file named
//          `50%20off.txt` travels the wire as `50%2520off.txt` and assembled as
//          `50 off.txt`. nc-dav.controller has always passed the still-encoded
//          subpath; this one disagreed.
//
//   #483 — a Destination that normalizes to nothing resolved to the space ROOT,
//          and the assembly ends in `moveFiles(tmp, space.realPath, true)` —
//          i.e. the user's whole home replaced by the uploaded file.
describe('NcUploadsController assembly destination', () => {
  const user = { id: 7, login: 'alice' } as any

  function buildController() {
    const staging = {
      concatenate: vi.fn().mockResolvedValue(1024),
      remove: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockReturnValue(true),
      ensureDir: vi.fn()
    }
    const spacesManager = {
      spaceEnv: vi.fn().mockResolvedValue({
        realPath: '/data/users/alice/files/x',
        dbFile: { ownerId: 7, path: 'x', inTrash: false },
        envPermissions: 'a:m:d',
        url: 'files/personal/x'
      })
    }
    const versioning = { snapshotBeforeOverwrite: vi.fn().mockResolvedValue(undefined) }

    vi.spyOn(filesUtils, 'isPathExists').mockResolvedValue(false)
    vi.spyOn(filesUtils, 'makeDir').mockResolvedValue('' as any)
    vi.spyOn(filesUtils, 'moveFiles').mockResolvedValue(undefined)

    // Real resolver: the decode-count and the null-vs-root distinction are its
    // behaviour, and mocking it would hide both defects.
    const controller = new NcUploadsController(
      staging as any,
      new NcPathResolverService() as any,
      noMounts() as any,
      spacesManager as any,
      versioning as any
    )
    return { controller, spacesManager }
  }

  const moveReq = (destination: string) =>
    ({
      user,
      method: 'MOVE',
      url: '/remote.php/dav/uploads/alice/up-1/.file',
      headers: { destination, 'oc-total-length': '1024' }
    }) as any

  const res = () => ({ status: vi.fn().mockReturnThis(), header: vi.fn().mockReturnThis(), send: vi.fn() }) as any

  afterEach(() => vi.restoreAllMocks())

  it('decodes the Destination exactly once (#484)', async () => {
    const { controller, spacesManager } = buildController()

    // On the wire for a file literally named `50%20off.txt`.
    await controller.chunkHandler('alice', 'up-1', moveReq('/remote.php/dav/files/alice/50%2520off.txt'), res())

    expect(spacesManager.spaceEnv).toHaveBeenCalledWith(user, ['files', 'personal', '50%20off.txt'])
  })

  it('decodes an ordinary escaped space once, not zero times', async () => {
    const { controller, spacesManager } = buildController()

    await controller.chunkHandler('alice', 'up-1', moveReq('/remote.php/dav/files/alice/My%20folder/a.txt'), res())

    expect(spacesManager.spaceEnv).toHaveBeenCalledWith(user, ['files', 'personal', 'My folder', 'a.txt'])
  })

  it('refuses a Destination carrying a "." segment rather than assembling onto the home root (#483)', async () => {
    const { controller, spacesManager } = buildController()

    await expect(controller.chunkHandler('alice', 'up-1', moveReq('/remote.php/dav/files/alice/a/./b'), res())).rejects.toMatchObject({
      status: 400
    })
    expect(spacesManager.spaceEnv).not.toHaveBeenCalled()
    expect(filesUtils.moveFiles).not.toHaveBeenCalled()
  })

  // `…/files/alice/` (one trailing slash) is caught by the PRE-EXISTING
  // `if (!destPath)` — parseDestination returns '' for it — so it proves
  // nothing about the `!resolved.relativePath` guard. The shape that guard
  // exists for is the DOUBLE slash: destPath is '/', which is truthy, so it
  // reached resolve(), came back with relativePath '' (the space ROOT), and
  // the assembly's `moveFiles(tmp, space.realPath, true)` replaced the user's
  // whole home with the uploaded file.
  it('refuses a Destination that resolves to the home root (#483)', async () => {
    const { controller, spacesManager } = buildController()

    await expect(controller.chunkHandler('alice', 'up-1', moveReq('/remote.php/dav/files/alice//'), res())).rejects.toMatchObject({
      status: 400
    })
    expect(spacesManager.spaceEnv).not.toHaveBeenCalled()
    expect(filesUtils.moveFiles).not.toHaveBeenCalled()
  })

  // parseDestination ran `new URL(dest).pathname` for the absolute form, and
  // WHATWG URL parsing erases dot segments (treating `%2e` as a dot) — so the
  // refusal above applied only to the path-relative form.
  it.each([
    ['https://cloud.example.org/remote.php/dav/files/alice/a/../b', 'plain ".."'],
    ['https://cloud.example.org/remote.php/dav/files/alice/a/./b', 'plain "."'],
    ['https://cloud.example.org/remote.php/dav/files/alice/a/%2e%2e/b', 'lowercase "%2e%2e"'],
    ['https://cloud.example.org/remote.php/dav/files/alice/a/%2E%2E/b', 'uppercase "%2E%2E"']
  ])('refuses an ABSOLUTE Destination carrying %s (%s)', async (destination) => {
    const { controller, spacesManager } = buildController()

    await expect(controller.chunkHandler('alice', 'up-1', moveReq(destination), res())).rejects.toMatchObject({ status: 400 })
    expect(spacesManager.spaceEnv).not.toHaveBeenCalled()
    expect(filesUtils.moveFiles).not.toHaveBeenCalled()
  })

  it('still assembles an ordinary ABSOLUTE Destination', async () => {
    const { controller, spacesManager } = buildController()

    await controller.chunkHandler('alice', 'up-1', moveReq('https://cloud.example.org/remote.php/dav/files/alice/photos/a.jpg'), res())

    expect(spacesManager.spaceEnv).toHaveBeenCalledWith(user, ['files', 'personal', 'photos', 'a.jpg'])
  })
})

// #516 — the chunked-upload assembly bypassed share-mount routing.
//
// `NcDavController.buildUrlSegments` matches the first subpath segment
// against the user's incoming share aliases and routes to shares/<alias>/… .
// `assembleAndMove` called `NcPathResolverService.resolve()` directly and had
// no share resolver injected at all, so `Destination:
// /remote.php/dav/files/alice/TeamShare/big.iso` resolved to
// ['files','personal','TeamShare','big.iso'], `makeDir(parentDir, true)`
// created `<home>/files/TeamShare/` and `moveFiles` wrote there. The client's
// follow-up PROPFIND of `files/alice/TeamShare/` routed to the SHARE (the
// alias wins the collision, by design), so the upload reported 201 and the
// file was invisible.
//
// Net effect before this: small files uploaded into a shared folder landed in
// the share, large (chunked) ones landed in personal and appeared to vanish.
describe('NcUploadsController assembly share-mount routing (#516)', () => {
  const user = { id: 7, login: 'alice' } as any

  function buildController(mounts: { alias: string }[], envPermissions = 'a:m:d') {
    const staging = {
      concatenate: vi.fn().mockResolvedValue(1024),
      remove: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockReturnValue(true),
      ensureDir: vi.fn()
    }
    const spacesManager = {
      spaceEnv: vi.fn().mockResolvedValue({
        realPath: '/data/spaces/team/big.iso',
        dbFile: { ownerId: 9, path: 'big.iso', inTrash: false },
        envPermissions,
        url: 'shares/TeamShare/big.iso'
      })
    }
    const versioning = { snapshotBeforeOverwrite: vi.fn().mockResolvedValue(undefined) }
    const shareMounts = noMounts(mounts)

    vi.spyOn(filesUtils, 'isPathExists').mockResolvedValue(false)
    vi.spyOn(filesUtils, 'makeDir').mockResolvedValue('' as any)
    vi.spyOn(filesUtils, 'moveFiles').mockResolvedValue(undefined)

    // Real resolver — the personal-home fallback it provides is half of what
    // is under test.
    const controller = new NcUploadsController(
      staging as any,
      new NcPathResolverService() as any,
      shareMounts as any,
      spacesManager as any,
      versioning as any
    )
    return { controller, spacesManager, shareMounts }
  }

  const moveReq = (destination: string) =>
    ({
      user,
      method: 'MOVE',
      url: '/remote.php/dav/uploads/alice/up-1/.file',
      headers: { destination, 'oc-total-length': '1024' }
    }) as any

  const res = () => ({ status: vi.fn().mockReturnThis(), header: vi.fn().mockReturnThis(), send: vi.fn() }) as any

  afterEach(() => vi.restoreAllMocks())

  it('routes the assembly into the share when the first segment is a mount alias', async () => {
    const { controller, spacesManager } = buildController([{ alias: 'TeamShare' }])

    await controller.chunkHandler('alice', 'up-1', moveReq('/remote.php/dav/files/alice/TeamShare/big.iso'), res())

    expect(spacesManager.spaceEnv).toHaveBeenCalledWith(user, ['shares', 'TeamShare', 'big.iso'])
  })

  it('decodes the alias segment before the lookup, exactly like the DAV surface', async () => {
    const { controller, spacesManager } = buildController([{ alias: 'pôt commun' }])

    await controller.chunkHandler('alice', 'up-1', moveReq('/remote.php/dav/files/alice/p%C3%B4t%20commun/big.iso'), res())

    expect(spacesManager.spaceEnv).toHaveBeenCalledWith(user, ['shares', 'pôt commun', 'big.iso'])
  })

  it('still falls through to the personal home when no alias matches', async () => {
    const { controller, spacesManager } = buildController([{ alias: 'TeamShare' }])

    await controller.chunkHandler('alice', 'up-1', moveReq('/remote.php/dav/files/alice/Documents/big.iso'), res())

    expect(spacesManager.spaceEnv).toHaveBeenCalledWith(user, ['files', 'personal', 'Documents', 'big.iso'])
  })

  // The share root is the #483 refusal read from the share side: a Destination
  // naming only the mount alias would have `moveFiles`d the assembled blob on
  // top of the whole shared folder.
  it('refuses a Destination that names only the mount alias', async () => {
    const { controller, spacesManager } = buildController([{ alias: 'TeamShare' }])

    await expect(controller.chunkHandler('alice', 'up-1', moveReq('/remote.php/dav/files/alice/TeamShare'), res())).rejects.toMatchObject({
      status: 400
    })
    expect(spacesManager.spaceEnv).not.toHaveBeenCalled()
    expect(filesUtils.moveFiles).not.toHaveBeenCalled()
  })

  // Routing into the share is what makes the pre-existing ADD/MODIFY check
  // read the SHARE's permissions instead of the user's own home permissions.
  it('refuses the assembly when the resolved share mount grants no write', async () => {
    const { controller } = buildController([{ alias: 'TeamShare' }], '')

    await expect(controller.chunkHandler('alice', 'up-1', moveReq('/remote.php/dav/files/alice/TeamShare/big.iso'), res())).rejects.toMatchObject({
      status: 403
    })
    expect(filesUtils.moveFiles).not.toHaveBeenCalled()
  })
})
