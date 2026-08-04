// The share and link WIRE PAYLOADS.
//
// Three bugs lived in these two functions at once, and all three were invisible to
// the type system, to the build and to every test — because the shapes are correct
// TypeScript and the server answers 200 to two of them:
//
//   1. A created link carried no `name`. `links.name` is `varchar NOT NULL` with no
//      default, so the insert failed and the whole share POST came back
//      `500 Unable to update link`. v2's "Get link" never worked.
//   2. An updated share sent no `links`. The server rebuilds the member set from
//      members + links and deletes what is missing, so editing the people on a share
//      silently revoked its public link. Verified live: PUT without links →
//      `links: []`; PUT with them echoed → the link survives.
//   3. An updated share sent `name: '_keep'`. The server writes any own-property that
//      differs from the stored row AND regenerates the alias when the name changes,
//      so editing a share renamed it to "_keep" and broke the URL its recipients had.
//
// These are assertions about a REQUEST BODY, so they need no server and no TestBed —
// just something that records what was sent. Which is the level the bugs were at.

import { describe, expect, it } from 'vitest'
import { MEMBER_TYPE } from '@sync-in-server/backend/src/applications/users/constants/member'
import type { HttpClient } from '@angular/common/http'
import { of } from 'rxjs'
import { createLinkShare } from './link-share'
import { createShare, updateShare } from './share-crud'

interface Sent {
  method: string
  url: string
  body: Record<string, unknown>
}

// Enough of HttpClient for these four calls, recording each one.
function recorder(): { http: HttpClient; sent: Sent[] } {
  const sent: Sent[] = []
  const capture =
    (method: string) =>
    (url: string, body: unknown = {}) => {
      sent.push({ method, url, body: body as Record<string, unknown> })
      return of({})
    }
  return { http: { post: capture('POST'), put: capture('PUT') } as unknown as HttpClient, sent }
}

const FILE = {
  id: 7,
  name: 'Travel checklist.txt',
  isDir: false,
  mime: 'text/plain',
  space: { alias: 'personal', name: 'personal', root: { alias: '', name: '' } }
} as never

describe('createLinkShare', () => {
  const build = () => {
    const { http, sent } = recorder()
    createLinkShare(http, {
      file: FILE,
      relativePath: 'Documents/Travel checklist.txt',
      ownerId: 1,
      settings: { uuid: 'abc123', requireAuth: false, isActive: true }
    }).subscribe()
    return sent[0]
  }

  // Bug 1. Without this the whole POST 500s — the link row cannot be inserted.
  it('names the link, because links.name is NOT NULL with no default', () => {
    const links = build().body.links as { linkSettings: { name?: string } }[]
    expect(links[0].linkSettings.name).toBe('Travel checklist.txt')
  })

  // The id convention is the one the server actually branches on: `link.id < 0` means
  // "create", anything else is "update by id" and 404s for an id it does not know.
  it('marks a new link with a negative id', () => {
    const links = build().body.links as { id: number }[]
    expect(links[0].id).toBeLessThan(0)
  })

  it('carries the uuid and the active flag', () => {
    const links = build().body.links as { linkSettings: { uuid: string; isActive: boolean } }[]
    expect(links[0].linkSettings.uuid).toBe('abc123')
    expect(links[0].linkSettings.isActive).toBe(true)
  })

  // An explicit setting wins over the default, so a caller can name a link something
  // other than the file.
  it('lets the caller override the name', () => {
    const { http, sent } = recorder()
    createLinkShare(http, {
      file: FILE,
      relativePath: 'x',
      ownerId: 1,
      settings: { uuid: 'u', requireAuth: false, isActive: true, name: 'Q3 handover' }
    }).subscribe()
    const links = sent[0].body.links as { linkSettings: { name?: string } }[]
    expect(links[0].linkSettings.name).toBe('Q3 handover')
  })
})

describe('updateShare', () => {
  const build = (over: Partial<Parameters<typeof updateShare>[1]> = {}) => {
    const { http, sent } = recorder()
    updateShare(http, {
      shareId: 12,
      name: 'Travel checklist.txt',
      members: [{ id: 2, type: MEMBER_TYPE.USER, permissions: '' }],
      links: [{ id: 20, linkId: 4, permissions: '' }],
      ...over
    }).subscribe()
    return sent[0]
  }

  // Bug 3. '_keep' was a placeholder on the theory that the server ignores the name of
  // an existing share. It does not: it writes it, and regenerates the alias with it.
  it('sends the share’s real name, never a placeholder', () => {
    expect(build().body.name).toBe('Travel checklist.txt')
    expect(build().body.name).not.toBe('_keep')
  })

  // Bug 2. The links have to come back or the server deletes them.
  it('echoes every link back so the update does not revoke it', () => {
    const links = build().body.links as { id: number; linkId: number; type: string }[]
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ id: 20, linkId: 4, type: MEMBER_TYPE.LINK })
  })

  // An echoed link must NOT carry linkSettings: that field is what marks a link as
  // modified and sends the server down its update path for no reason.
  it('sends no linkSettings on an echoed link, so it counts as unchanged', () => {
    const links = build().body.links as Record<string, unknown>[]
    expect(links[0]).not.toHaveProperty('linkSettings')
  })

  it('still sends the members, and the link is not one of them', () => {
    const members = build().body.members as { id: number; type: string }[]
    expect(members).toEqual([{ id: 2, type: MEMBER_TYPE.USER, permissions: '' }])
  })

  it('sends an empty links array when the share genuinely has none', () => {
    expect(build({ links: [] }).body.links).toEqual([])
  })

  it('puts to the share’s own id', () => {
    expect(build().url).toContain('/12')
    expect(build().method).toBe('PUT')
  })
})

describe('createShare', () => {
  // Unlike an update, a create has no links to preserve — but the field must still be
  // present, because the DTO requires an array and the server iterates it.
  it('sends an empty links array', () => {
    const { http, sent } = recorder()
    createShare(http, {
      file: FILE,
      relativePath: 'Documents/Travel checklist.txt',
      ownerId: 1,
      members: [{ id: 2, type: MEMBER_TYPE.USER, permissions: '' }]
    }).subscribe()
    expect(sent[0].body.links).toEqual([])
    expect(sent[0].body.name).toBe('Travel checklist.txt')
  })
})
