// Which COLLECTION each Shared tab reads.
//
// Two of the three tabs shipped empty for months (#429, #430) and nothing caught it,
// because both bugs are invisible to types and to the DOM: the screen filtered
// `/api/app/shares/list`, which is scoped server-side to shares you OWN and to
// SHARE_TYPE.COMMON. An incoming share and a public link are absent from that
// response by construction, so `shares.filter(s => !!s.parent)` and
// `shares.filter(s => s.counts.links > 0)` were predicates over rows that can never
// exist — a correct-looking filter producing a permanent empty state.
//
// So these cases assert the URL each variant requests, plus the mapping of each
// response shape into a row. A regression to "one endpoint, three filters" fails the
// first three.
//
// The first fix for #430 then swapped one wrong endpoint for another: "Via links" read
// `links/list` ALONE, which pins `shares.type = LINK`, and v2 never creates a share of
// that type — its merged dialog posts no `type` and the server defaults it to COMMON.
// So the tab was still empty for every link v2 itself had made. It reads both
// collections now, and `resolves a link on a COMMON share` below is the case that
// distinguishes them.
//
// Reuses the file-browser harness (plain Injector, no TestBed) — see
// `files/testing/file-browser-harness.ts` for why there is no DOM here.

import { describe, expect, it } from 'vitest'
import type { HarnessDeps, MountResult } from '../files/testing/file-browser-harness'
import { installWindowStub, mount } from '../files/testing/file-browser-harness'
import { SharedComponent, SharedRow, SharedVariant } from './shared.component'

const SHARES_LIST = '/api/app/shares/list'
const LINKS_LIST = '/api/app/shares/links/list'
const SHARES_REPOSITORY = '/api/app/spaces/browse/shares'
const share = (id: number) => `/api/app/shares/${id}`

/** The protected surface these cases drive. */
interface SharedApi {
  ngOnInit(): void
  rows: () => SharedRow[]
  loading: () => boolean
  errorMessage: () => string | null
  openRow(row: SharedRow): void
  config: () => { secondaryLabel: string; whenLabel: string }
}

function start(variant: SharedVariant, configure?: (deps: HarnessDeps) => void): MountResult<SharedComponent> & { c: SharedApi; deps: HarnessDeps } {
  const res = mount(SharedComponent, (deps) => {
    deps.routeData.next({ variant })
    configure?.(deps)
  })
  const c = res.component as unknown as SharedApi
  c.ngOnInit()
  res.flush()
  return { ...res, c, deps: res.deps }
}

describe('v2 Shared — each tab reads its own collection', () => {
  it('"With me" browses the shares REPOSITORY, not the owner-scoped share list', () => {
    const { deps } = start('with-me')
    expect(deps.log.only('http.get').args[0]).toBe(SHARES_REPOSITORY)
    expect(deps.log.of('http.get').map((c) => c.args[0])).not.toContain(SHARES_LIST)
  })

  it('"Via links" reads BOTH collections that can hold a link, because the two types partition them', () => {
    const { deps } = start('via-links')
    expect(
      deps.log
        .of('http.get')
        .map((c) => c.args[0])
        .sort()
    ).toEqual([SHARES_LIST, LINKS_LIST].sort())
  })

  it('"With others" still reads the owner-scoped share list', () => {
    const { deps } = start('with-others')
    expect(deps.log.only('http.get').args[0]).toBe(SHARES_LIST)
  })
})

describe('v2 Shared — row mapping', () => {
  it('turns each shares-repository entry into a row naming its owner', () => {
    const { c } = start('with-me', (deps) => {
      deps.httpGetResponses.set(SHARES_REPOSITORY, {
        space: { alias: 'shares', name: 'shares' },
        files: [
          {
            id: 41,
            name: 'Benchmarks',
            isDir: true,
            mime: 'directory',
            mtime: 1_700_000_000_000,
            root: { id: 7, alias: 'benchmarks', description: 'Q3 numbers', owner: { login: 'bob', fullName: 'Bob Stone' } }
          },
          {
            id: 42,
            name: 'Sync engine notes.md',
            isDir: false,
            mime: 'text-markdown',
            mtime: 1_700_000_001_000,
            root: { id: 8, alias: 'sync-engine-notes', owner: { login: 'ann', fullName: '' } }
          }
        ]
      })
    })
    expect(c.rows().map((r) => [r.name, r.secondary, r.alias, r.filePath])).toEqual([
      ['Benchmarks', 'Bob Stone', 'benchmarks', ''],
      // A shared FILE is addressable by the v2 file screen; it browses the parent
      // (`shares`) and matches on name, which is this very listing.
      // Addressed by ALIAS. The wire resolves `shares/<segment>` through
      // `shares.alias`, and an alias is a slug — 'Sync engine notes.md' is not one.
      ['Sync engine notes.md', 'ann', 'sync-engine-notes', 'shares/sync-engine-notes']
    ])
    // The recipient owns none of these, so there is no share to open an editor on.
    expect(c.rows().every((r) => r.shareId === 0)).toBe(true)
  })

  it('gives every link its own row, keyed on the LINK, so one share with two links lists twice', () => {
    const { c } = start('via-links', (deps) => {
      deps.httpGetResponses.set(LINKS_LIST, [
        {
          id: 9,
          name: 'Report.pdf',
          alias: 'report-pdf',
          file: { mime: 'application/pdf' },
          link: { id: 1, name: 'For the board', currentAccess: 1_700_000_000_000 }
        },
        {
          id: 9,
          name: 'Report.pdf',
          alias: 'report-pdf',
          file: { mime: 'application/pdf' },
          link: { id: 2, name: 'For the auditor', currentAccess: null }
        }
      ])
    })
    expect(c.rows().map((r) => r.key)).toEqual(['link-1', 'link-2'])
    expect(c.rows().map((r) => r.secondary)).toEqual(['For the board', 'For the auditor'])
    // Both rows edit the same share — that is the handle the v2 share dialog takes.
    expect(c.rows().map((r) => r.shareId)).toEqual([9, 9])
  })

  it('resolves a link on a COMMON share — the only kind v2 creates — through GET /shares/:id', () => {
    const { c, deps } = start('via-links', (deps) => {
      // Nothing of type LINK at all: this is an instance where every link was made
      // by v2's merged dialog.
      deps.httpGetResponses.set(LINKS_LIST, [])
      deps.httpGetResponses.set(SHARES_LIST, [
        { id: 5, name: 'Budget.xlsx', alias: 'budget-xlsx', counts: { users: 1, groups: 0, links: 1, shares: 0 } },
        { id: 6, name: 'No link here', alias: 'no-link-here', counts: { users: 2, groups: 0, links: 0, shares: 0 } }
      ])
      deps.httpGetResponses.set(share(5), {
        id: 5,
        name: 'Budget.xlsx',
        members: [
          { id: 30, name: 'Ann Jones', type: 'user' },
          { id: 31, linkId: 77, name: 'For the board', type: 'user' }
        ]
      })
    })
    // Only the share that HAS a link is looked up; the other one costs no request.
    expect(deps.log.of('http.get').map((call) => call.args[0])).toEqual([LINKS_LIST, SHARES_LIST, share(5)])
    expect(c.rows().map((r) => [r.key, r.name, r.secondary, r.shareId])).toEqual([['link-77', 'Budget.xlsx', 'For the board', 5]])
  })

  it('still lists a COMMON share whose per-share lookup failed, with the Link column blank', () => {
    const { c } = start('via-links', (deps) => {
      deps.httpGetResponses.set(LINKS_LIST, [])
      deps.httpGetResponses.set(SHARES_LIST, [
        { id: 5, name: 'Budget.xlsx', alias: 'budget-xlsx', counts: { users: 0, groups: 0, links: 2, shares: 0 } }
      ])
      // No stub for GET /shares/5 -> the harness answers `{ files: [] }`, i.e. a body
      // with no members, which is the same branch a failed lookup takes.
    })
    expect(c.rows().map((r) => [r.key, r.name, r.secondary, r.links])).toEqual([['share-5-links', 'Budget.xlsx', '', 2]])
  })

  it('unions the two collections and orders the tab by name', () => {
    const { c } = start('via-links', (deps) => {
      deps.httpGetResponses.set(LINKS_LIST, [
        { id: 9, name: 'Zebra.pdf', alias: 'zebra-pdf', link: { id: 1, name: 'Classic link', currentAccess: 1_700_000_000_000 } }
      ])
      deps.httpGetResponses.set(SHARES_LIST, [
        { id: 5, name: 'Apple.xlsx', alias: 'apple-xlsx', counts: { users: 0, groups: 0, links: 1, shares: 0 } }
      ])
      deps.httpGetResponses.set(share(5), { id: 5, members: [{ id: 31, linkId: 77, name: 'v2 link' }] })
    })
    expect(c.rows().map((r) => r.name)).toEqual(['Apple.xlsx', 'Zebra.pdf'])
  })

  it('lists every outgoing share, including re-shares nested in a share the user received', () => {
    const { c } = start('with-others', (deps) => {
      deps.httpGetResponses.set(SHARES_LIST, [
        { id: 1, name: 'Plain', alias: 'plain', counts: { users: 2, groups: 1, links: 0, shares: 0 } },
        // `parent` means "created inside a share someone made to me". The old
        // `!s.parent` filter dropped these, and the "with me" tab it fed them to
        // could never show them either.
        {
          id: 2,
          name: 'Nested',
          alias: 'nested',
          parent: { id: 1, alias: 'plain', name: 'Plain' },
          counts: { users: 1, groups: 0, links: 1, shares: 0 }
        }
      ])
    })
    expect(c.rows().map((r) => r.name)).toEqual(['Plain', 'Nested'])
    expect(c.rows().map((r) => r.users + r.groups)).toEqual([3, 1])
  })

  it('reports a failed load instead of rendering an empty state', () => {
    const { c } = start('with-me', (deps) => {
      deps.httpGetError = 500
    })
    expect(c.errorMessage()).toBe('Failed to load shares.')
    expect(c.loading()).toBe(false)
  })
})

describe('v2 Shared — opening a row', () => {
  it('opens the share editor for an outgoing share', () => {
    const { c, deps } = start('with-others', (deps) => {
      deps.httpGetResponses.set(SHARES_LIST, [{ id: 5, name: 'Plain', alias: 'plain', counts: { users: 1, groups: 0, links: 0, shares: 0 } }])
    })
    c.openRow(c.rows()[0])
    expect(deps.log.only('shareDialog.open').args[0]).toEqual({ existingShareId: 5 })
  })

  it('opens the share editor with the link zone on for a link row — the only way to reach it', () => {
    const { c, deps } = start('via-links', (deps) => {
      deps.httpGetResponses.set(LINKS_LIST, [{ id: 9, name: 'Report.pdf', alias: 'report-pdf', link: { id: 1, name: 'For the board' } }])
    })
    c.openRow(c.rows()[0])
    expect(deps.log.only('shareDialog.open').args[0]).toEqual({ existingShareId: 9, focusLink: true })
  })

  it('opens a shared FILE on the v2 file screen', () => {
    const { c, deps } = start('with-me', (deps) => {
      deps.httpGetResponses.set(SHARES_REPOSITORY, {
        files: [
          {
            id: 42,
            name: 'Sprint notes.md',
            isDir: false,
            mime: 'text-markdown',
            mtime: 1,
            root: { alias: 'sprint-notes-md', owner: { login: 'ann' } }
          }
        ]
      })
    })
    c.openRow(c.rows()[0])
    const nav = deps.log.only('router.navigate')
    expect(nav.args[0]).toEqual(['/', 'v2', 'file'])
    // The SHARE ALIAS. With the name here the row rendered and every content URL
    // under it 404'd — preview, PDF viewer and Download alike (#429).
    expect(nav.args[1]).toEqual({ queryParams: { path: 'shares/sprint-notes-md' } })
  })

  it('tells the user when a row can be addressed neither way instead of swallowing the click', () => {
    const { c, deps } = start('with-me', (deps) => {
      deps.httpGetResponses.set(SHARES_REPOSITORY, {
        files: [{ id: 41, name: 'Orphan', isDir: true, mime: 'directory', mtime: 1, root: { owner: { login: 'bob' } } }]
      })
    })
    c.openRow(c.rows()[0])
    expect(deps.log.count('toast.error')).toBe(1)
    expect(deps.log.count('router.navigate')).toBe(0)
  })

  it('hands a shared FOLDER to the classic browser and SUSPENDS the guard, keeping the v2 preference', () => {
    const { win, restore } = installWindowStub({ 'ui.version': 'v2' })
    try {
      const { c, deps } = start('with-me', (deps) => {
        deps.httpGetResponses.set(SHARES_REPOSITORY, {
          files: [{ id: 41, name: 'Benchmarks', isDir: true, mime: 'directory', mtime: 1, root: { alias: 'benchmarks', owner: { login: 'bob' } } }]
        })
      })
      c.openRow(c.rows()[0])
      // The preference SURVIVES. Clearing it here ejected the user from v2 for good
      // over one folder click; the suspension lasts the tab and lifts on any /v2 route.
      expect(win.storage.get('ui.version')).toBe('v2')
      expect(win.session.get('ui.version.suspended')).toBe('1')
      expect(deps.log.only('router.navigate').args[0]).toEqual(['/spaces/shares', 'benchmarks'])
      expect(deps.log.count('toast.info')).toBe(1)
    } finally {
      restore()
    }
  })
})
