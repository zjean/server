import { NestFastifyApplication } from '@nestjs/platform-fastify'
import { XMLParser } from 'fast-xml-parser'
import fs from 'node:fs/promises'
import { appBootstrap } from '../../../app.bootstrap'
import { USER_PERMISSION, USER_PERMS_SEP, USER_ROLE } from '../../users/constants/user'
import { UserModel } from '../../users/models/user.model'
import { AdminUsersManager } from '../../users/services/admin-users-manager.service'
import { generateUserTest } from '../../users/utils/test'
import { NcAppPasswordService } from '../services/nc-app-password.service'

// The NC chunked-upload protocol, driven end to end over HTTP — specifically the
// INTERRUPT-AND-RESUME path.
//
// WHY THIS EXISTS. `buildUploadDirPropfindBody` is already covered twice over as
// a pure function: semantically in nc-uploads.controller.spec.ts and
// byte-for-byte in nc-xml-wire-pin.spec.ts. Neither can prove the thing the
// resume actually depends on, which is that the LIVE handler stats the real
// staged chunks and emits sizes that sum to the true byte count. #362 changed
// those bytes (pretty-printed → compact, self-closing → explicitly closed) and
// shipped unverified against this path, which is the only path they feed.
//
// The failure mode if it is wrong is silent and expensive rather than loud:
// Android's ChunkedFileUploadRemoteOperation sums `getcontentlength` across the
// listing to compute `nextByte`, and a chunk misread as a directory has no size
// to sum — so the client resumes from byte 0 and re-uploads the whole transfer,
// on the slowest networks there are. Nothing errors.
//
// The cases below therefore parse the PROPFIND the way the client does — sum the
// children, exclude the collection — instead of asserting on substrings.
describe('NC chunked upload, interrupted and resumed (e2e)', () => {
  let app: NestFastifyApplication
  let admin: AdminUsersManager
  let user: UserModel
  // NcBasicAuthGuard accepts ONLY an app-password scoped to MOBILE_NC and
  // deliberately refuses the user's main login password, matching Nextcloud's
  // own posture — so this cannot be the Basic header WebDAV would take.
  let ncAuth: string

  beforeAll(async () => {
    app = await appBootstrap()
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    admin = app.get(AdminUsersManager)
    // `permissions` is the column; `applications` is derived from it and is not
    // one. A user built straight from generateUserTest() lands with no
    // permissions and every request 403s — see the versioning fixture's note 1.
    user = await admin.createUserOrGuest(
      { ...generateUserTest(false), permissions: Object.values(USER_PERMISSION).join(USER_PERMS_SEP) } as never,
      USER_ROLE.USER
    )
    const minted = await app.get(NcAppPasswordService).mintMobileAppPassword(user, 'nc-chunked-e2e')
    ncAuth = `Basic ${Buffer.from(`${user.login}:${minted.password}`).toString('base64')}`
  })

  afterAll(async () => {
    if (user?.id) {
      await admin.deleteUserOrGuest(user.id, user.login, { deleteSpace: true, isGuest: false } as never).catch(() => undefined)
    }
    await app?.close()
  })

  const nc = (method: string, url: string, opts: { payload?: string; headers?: Record<string, string> } = {}) =>
    app.inject({
      method,
      url,
      headers: { authorization: ncAuth, ...(opts.headers ?? {}) },
      ...(opts.payload === undefined ? {} : { payload: opts.payload })
    } as never)

  const parser = new XMLParser({ ignoreAttributes: false })

  // Read the staging listing the way the client does.
  //
  // `nextByte` is the SUM OF THE CHILDREN's content lengths — the collection's
  // own response must not be counted, which is why it is matched out by href
  // rather than by position. A chunk whose resourcetype is non-empty is reported
  // separately, because Android's WebdavEntry turns any non-null resourcetype
  // value into contentType DIR and a directory contributes no size at all.
  const readStaging = (body: string, uploadRoot: string) => {
    const parsed = parser.parse(body)
    const multistatus = parsed['d:multistatus']
    expect(multistatus).toBeDefined()
    const responses = [multistatus['d:response']].flat().filter(Boolean)
    const children = responses.filter((r: Record<string, string>) => r['d:href'] !== uploadRoot)
    const collection = responses.filter((r: Record<string, string>) => r['d:href'] === uploadRoot)
    return {
      collectionCount: collection.length,
      names: children.map((r: Record<string, string>) => decodeURIComponent(String(r['d:href']).slice(`${uploadRoot}/`.length))),
      nextByte: children.reduce((sum: number, r: never) => sum + Number(r['d:propstat']['d:prop']['d:getcontentlength']), 0),
      // '' is what an empty element parses to; anything truthy is a directory to
      // the client.
      readAsDirectory: children.filter((r: never) => !!r['d:propstat']['d:prop']['d:resourcetype']).length
    }
  }

  it('reports a resume offset that matches the bytes actually staged, and assembles correctly from it', async () => {
    const rel = 'nc-resume-target.bin'
    const uploadId = `e2e-resume-${Date.now()}`
    const uploadRoot = `/remote.php/dav/uploads/${user.login}/${uploadId}`

    // Chunk names are the client's; the staging service assembles in numeric
    // name order, which is why NC pads them.
    const chunks = [
      { name: '00000001', payload: 'A'.repeat(4096) },
      { name: '00000002', payload: 'B'.repeat(2048) },
      { name: '00000003', payload: 'C'.repeat(1024) }
    ]
    const whole = chunks.map((c) => c.payload).join('')

    expect((await nc('MKCOL', uploadRoot)).statusCode).toBe(201)

    // ── the transfer, interrupted after two of three chunks
    for (const chunk of chunks.slice(0, 2)) {
      expect([200, 201, 204]).toContain((await nc('PUT', `${uploadRoot}/${chunk.name}`, { payload: chunk.payload })).statusCode)
    }

    // ── the resume probe
    const probe = await nc('PROPFIND', uploadRoot, { headers: { depth: '1' } })
    expect(probe.statusCode).toBe(207)
    expect(String(probe.headers['content-type'])).toContain('application/xml')

    const staged = readStaging(probe.body, uploadRoot)
    // The collection is present exactly once and is not part of the sum.
    expect(staged.collectionCount).toBe(1)
    expect(staged.names.sort()).toEqual(['00000001', '00000002'])
    // THE ASSERTION THE RESUME RIDES ON: the offset the client would restart
    // from is the byte count really on disk, not 0.
    expect(staged.nextByte).toBe(4096 + 2048)
    // And no chunk is readable as a directory, which is how the size disappears.
    expect(staged.readAsDirectory).toBe(0)

    // ── resume from that offset and finish
    const tail = chunks[2]
    expect([200, 201, 204]).toContain((await nc('PUT', `${uploadRoot}/${tail.name}`, { payload: tail.payload })).statusCode)

    const move = await nc('MOVE', `${uploadRoot}/.file`, {
      headers: {
        destination: `/remote.php/dav/files/${user.login}/${rel}`,
        // The client computes this from its own total, so a resume that
        // miscounted would be caught here as a size mismatch — asserting the
        // 201 is asserting that the offset above was right.
        'oc-total-length': String(Buffer.byteLength(whole))
      }
    })
    expect([201, 204]).toContain(move.statusCode)

    const assembled = await fs.readFile(`${UserModel.getFilesPath(user.login)}/${rel}`, 'utf8')
    expect(assembled).toBe(whole)
    expect(Buffer.byteLength(assembled)).toBe(4096 + 2048 + 1024)
  })

  // Two chunks named such that lexical order disagrees with numeric order. The
  // sum is order-independent, but the ASSEMBLY is not, and a resume that
  // reported the right offset while concatenating in the wrong order would
  // produce a file of the correct length and the wrong content — which no length
  // assertion catches.
  it('assembles in the client’s numeric chunk order, not lexical order', async () => {
    const rel = 'nc-resume-order.bin'
    const uploadId = `e2e-order-${Date.now()}`
    const uploadRoot = `/remote.php/dav/uploads/${user.login}/${uploadId}`
    expect((await nc('MKCOL', uploadRoot)).statusCode).toBe(201)

    for (const [name, payload] of [
      ['2', 'second-'],
      ['10', 'tenth'],
      ['1', 'first-']
    ]) {
      expect([200, 201, 204]).toContain((await nc('PUT', `${uploadRoot}/${name}`, { payload })).statusCode)
    }

    const staged = readStaging((await nc('PROPFIND', uploadRoot, { headers: { depth: '1' } })).body, uploadRoot)
    expect(staged.nextByte).toBe(Buffer.byteLength('second-tenthfirst-'))

    const move = await nc('MOVE', `${uploadRoot}/.file`, {
      headers: { destination: `/remote.php/dav/files/${user.login}/${rel}` }
    })
    expect([201, 204]).toContain(move.statusCode)
    expect(await fs.readFile(`${UserModel.getFilesPath(user.login)}/${rel}`, 'utf8')).toBe('first-second-tenth')
  })

  // Depth 0 is "does this collection exist", and the old pre-resume shape. Kept
  // deliberately: enumerating children there would make every existence probe
  // pay for a directory stat.
  it('answers depth 0 with the collection alone, even with chunks staged', async () => {
    const uploadId = `e2e-depth0-${Date.now()}`
    const uploadRoot = `/remote.php/dav/uploads/${user.login}/${uploadId}`
    expect((await nc('MKCOL', uploadRoot)).statusCode).toBe(201)
    expect([200, 201, 204]).toContain((await nc('PUT', `${uploadRoot}/00000001`, { payload: 'staged' })).statusCode)

    const staged = readStaging((await nc('PROPFIND', uploadRoot, { headers: { depth: '0' } })).body, uploadRoot)
    expect(staged.collectionCount).toBe(1)
    expect(staged.names).toEqual([])
    expect(staged.nextByte).toBe(0)
  })

  // A resume that got the offset wrong sends the wrong bytes, and OC-Total-Length
  // is the end-to-end re-verify that turns that into a refusal instead of a
  // corrupt file. Nothing may land at the destination.
  it('refuses the assembly when the total disagrees, leaving no file behind', async () => {
    const rel = 'nc-resume-mismatch.bin'
    const uploadId = `e2e-mismatch-${Date.now()}`
    const uploadRoot = `/remote.php/dav/uploads/${user.login}/${uploadId}`
    expect((await nc('MKCOL', uploadRoot)).statusCode).toBe(201)
    expect([200, 201, 204]).toContain((await nc('PUT', `${uploadRoot}/00000001`, { payload: 'twelve bytes' })).statusCode)

    const move = await nc('MOVE', `${uploadRoot}/.file`, {
      headers: {
        destination: `/remote.php/dav/files/${user.login}/${rel}`,
        'oc-total-length': '999'
      }
    })
    expect(move.statusCode).toBe(400)
    await expect(fs.stat(`${UserModel.getFilesPath(user.login)}/${rel}`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  // The staging dir is removed once assembly has been attempted, success or
  // failure — so a resume probe after the transfer completed finds nothing and
  // the client starts a fresh upload id rather than resuming into a dir whose
  // chunks are gone.
  it('leaves no staging dir behind after the assembly MOVE', async () => {
    const rel = 'nc-resume-cleanup.bin'
    const uploadId = `e2e-cleanup-${Date.now()}`
    const uploadRoot = `/remote.php/dav/uploads/${user.login}/${uploadId}`
    expect((await nc('MKCOL', uploadRoot)).statusCode).toBe(201)
    expect([200, 201, 204]).toContain((await nc('PUT', `${uploadRoot}/00000001`, { payload: 'done' })).statusCode)
    expect([201, 204]).toContain(
      (await nc('MOVE', `${uploadRoot}/.file`, { headers: { destination: `/remote.php/dav/files/${user.login}/${rel}` } })).statusCode
    )

    expect((await nc('GET', uploadRoot)).statusCode).toBe(404)
    const staged = readStaging((await nc('PROPFIND', uploadRoot, { headers: { depth: '1' } })).body, uploadRoot)
    expect(staged.names).toEqual([])
    expect(staged.nextByte).toBe(0)
  })
})
