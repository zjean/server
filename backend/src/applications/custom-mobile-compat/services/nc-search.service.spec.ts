import { Test, TestingModule } from '@nestjs/testing'
import type { FastifyReply } from 'fastify'
import { DB_TOKEN_PROVIDER } from '../../../infrastructure/database/constants'
import type { FileRecent } from '../../files/schemas/file-recent.interface'
import { FilesRecents } from '../../files/services/files-recents.service'
import type { UserModel } from '../../users/models/user.model'
import { NcPathResolverService } from './nc-path-resolver.service'
import { NcSearchService } from './nc-search.service'

// Tests focus on observable behavior: HTTP status, content-type, and the
// shape of the XML body. The exact wire-format byte-equivalence with PROPFIND
// is asserted indirectly — we look for the few <oc:fileid> / <d:href> / etc.
// tokens NextcloudKit's parser navigates to.

function makeRes(): { res: FastifyReply; headers: Record<string, string>; status: number; body: string } {
  const state: { res: FastifyReply; headers: Record<string, string>; status: number; body: string } = {
    res: undefined as unknown as FastifyReply,
    headers: {},
    status: 0,
    body: ''
  }
  const res = {
    header: (k: string, v: string) => {
      state.headers[k] = v
      return res
    },
    status: (s: number) => {
      state.status = s
      return res
    },
    send: (payload: string) => {
      state.body = payload
      return res
    }
  }
  state.res = res as unknown as FastifyReply
  return state
}

function user(overrides: Partial<UserModel> = {}): UserModel {
  return { id: 7, login: 'alice', fullName: 'Alice', settings: null, ...overrides } as unknown as UserModel
}

function recent(overrides: Partial<FileRecent> = {}): FileRecent {
  return {
    id: 100,
    ownerId: 1,
    spaceId: 0,
    shareId: 0,
    path: 'files/personal/Documents',
    name: 'report.docx',
    mime: 'application-vnd.openxmlformats-officedocument.wordprocessingml.document',
    mtime: 1714742400000,
    ...overrides
  } as FileRecent
}

function recentBody(scopeHref = '/files/alice', ts = '1714742400'): string {
  return `<?xml version="1.0"?>
<d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns" xmlns:ns="http://nextcloud.org/ns">
<d:basicsearch>
  <d:select><d:prop><d:displayname/></d:prop></d:select>
  <d:from><d:scope><d:href>${scopeHref}</d:href><d:depth>infinity</d:depth></d:scope></d:from>
  <d:where><d:and>
    <d:or>
      <d:not><d:eq><d:prop><d:getcontenttype/></d:prop><d:literal>httpd/unix-directory</d:literal></d:eq></d:not>
      <d:eq><d:prop><oc:size/></d:prop><d:literal>0</d:literal></d:eq>
    </d:or>
    <d:gt><d:prop><d:getlastmodified/></d:prop><d:literal>${ts}</d:literal></d:gt>
  </d:and></d:where>
  <d:orderby><d:order><d:prop><d:getlastmodified/></d:prop><d:descending/></d:order></d:orderby>
  <d:limit><d:nresults>100</d:nresults><ns:firstresult>0</ns:firstresult></d:limit>
</d:basicsearch>
</d:searchrequest>`
}

describe(NcSearchService.name, () => {
  let moduleRef: TestingModule
  let svc: NcSearchService
  let getRecents: jest.Mock
  let dbSelectFiles: jest.Mock // controls the rows returned by db.select().from(files).where(...)

  beforeAll(async () => {
    getRecents = jest.fn()
    dbSelectFiles = jest.fn()

    // Minimal db proxy — drizzle chains .select().from(table).where(clause)
    // and awaits the result. We only need the chain terminator to resolve.
    const db = {
      select: () => ({
        from: () => ({
          where: (..._args: unknown[]) => Promise.resolve(dbSelectFiles())
        })
      })
    }

    moduleRef = await Test.createTestingModule({
      providers: [
        NcSearchService,
        NcPathResolverService,
        { provide: FilesRecents, useValue: { getRecents } },
        { provide: DB_TOKEN_PROVIDER, useValue: db }
      ]
    }).compile()
    moduleRef.useLogger(['fatal'])
    svc = moduleRef.get(NcSearchService)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  beforeEach(() => {
    getRecents.mockReset()
    dbSelectFiles.mockReset()
    dbSelectFiles.mockReturnValue([])
  })

  it('returns 207 multistatus with XML content-type for any input', async () => {
    getRecents.mockResolvedValue([])
    const r = makeRes()

    await svc.respond(user(), recentBody(), r.res)

    expect(r.status).toBe(207)
    expect(r.headers['Content-Type']).toBe('application/xml; charset=utf-8')
    expect(r.body).toContain('<?xml')
    expect(r.body).toContain('<d:multistatus')
  })

  it('returns empty multistatus for empty body — never 4xx/5xx (iOS logout-on-error)', async () => {
    const r = makeRes()

    await svc.respond(user(), null, r.res)

    expect(r.status).toBe(207)
    expect(r.body).toContain('<d:multistatus')
    expect(r.body).not.toContain('<d:response>')
    expect(getRecents).not.toHaveBeenCalled()
  })

  it('returns empty multistatus for unrecognized SEARCH bodies (Media tab, third-party clients)', async () => {
    const r = makeRes()
    const otherBody = `<?xml version="1.0"?><d:searchrequest xmlns:d="DAV:"><d:other/></d:searchrequest>`

    await svc.respond(user(), otherBody, r.res)

    expect(r.status).toBe(207)
    expect(r.body).not.toContain('<d:response>')
    expect(getRecents).not.toHaveBeenCalled()
  })

  it('returns empty multistatus when the body scope mismatches the authenticated user', async () => {
    const r = makeRes()

    await svc.respond(user({ login: 'alice' }), recentBody('/files/eve'), r.res)

    expect(r.status).toBe(207)
    expect(r.body).not.toContain('<d:response>')
    expect(getRecents).not.toHaveBeenCalled()
  })

  it('returns empty multistatus when there are no recents', async () => {
    getRecents.mockResolvedValue([])
    const r = makeRes()

    await svc.respond(user(), recentBody(), r.res)

    expect(r.status).toBe(207)
    expect(r.body).not.toContain('<d:response>')
  })

  it('emits one <d:response> per in-home recent that has a matching files row', async () => {
    getRecents.mockResolvedValue([
      recent({ id: 1, name: 'q1.pdf', path: 'files/personal/Reports' }),
      recent({ id: 2, name: 'logo.svg', path: 'files/personal' })
    ])
    dbSelectFiles.mockReturnValue([
      { id: 1, isDir: false, name: 'q1.pdf', size: 1024, ctime: 1700000000000, mtime: 1714742400000, mime: 'application/pdf' },
      { id: 2, isDir: false, name: 'logo.svg', size: 512, ctime: 1700000000000, mtime: 1714742400000, mime: 'image/svg+xml' }
    ])
    const r = makeRes()

    await svc.respond(user(), recentBody(), r.res)

    // Both files should appear with correct hrefs under the user's NC home
    expect(r.body).toContain('<d:href>/remote.php/dav/files/alice/Reports/q1.pdf</d:href>')
    expect(r.body).toContain('<d:href>/remote.php/dav/files/alice/logo.svg</d:href>')
    expect((r.body.match(/<d:response>/g) ?? []).length).toBe(2)
  })

  it('drops recents whose storage path is outside the user’s NC home (would 404 on tap)', async () => {
    getRecents.mockResolvedValue([
      recent({ id: 1, path: 'files/personal/Reports', name: 'mine.pdf' }),
      recent({ id: 2, path: 'files/team-marketing/Brand', name: 'logo.svg' })
    ])
    dbSelectFiles.mockReturnValue([
      // db.select for [1] only — the second recent was filtered before query
      { id: 1, isDir: false, name: 'mine.pdf', size: 1, ctime: 0, mtime: 0, mime: 'application/pdf' }
    ])
    const r = makeRes()

    await svc.respond(user(), recentBody(), r.res)

    expect(r.body).toContain('mine.pdf')
    expect(r.body).not.toContain('logo.svg')
  })

  it('drops directory rows — only files belong in the Recent tab', async () => {
    getRecents.mockResolvedValue([recent({ id: 1, name: 'subdir', path: 'files/personal/Documents' })])
    // db row says isDir=true
    dbSelectFiles.mockReturnValue([{ id: 1, isDir: true, name: 'subdir', size: 0, ctime: 0, mtime: 0, mime: null }])
    const r = makeRes()

    await svc.respond(user(), recentBody(), r.res)

    expect(r.body).not.toContain('<d:response>')
  })

  it('handles a recent whose files row was deleted between getRecents and the lookup', async () => {
    getRecents.mockResolvedValue([recent({ id: 1, name: 'gone.txt', path: 'files/personal' })])
    dbSelectFiles.mockReturnValue([]) // file row absent
    const r = makeRes()

    await svc.respond(user(), recentBody(), r.res)

    expect(r.status).toBe(207)
    expect(r.body).not.toContain('<d:response>')
  })

  it('returns empty multistatus instead of 5xx when the DB layer throws', async () => {
    getRecents.mockResolvedValue([recent()])
    dbSelectFiles.mockImplementation(() => {
      throw new Error('boom')
    })
    const r = makeRes()

    await svc.respond(user(), recentBody(), r.res)

    expect(r.status).toBe(207)
    expect(r.body).toContain('<d:multistatus')
  })
})
