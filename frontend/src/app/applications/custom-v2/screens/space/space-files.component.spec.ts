// Behavioural pin for the v2 space-files browser.
//
// See personal.component.spec.ts for the other half. The shared contract runs
// first; everything after it is space-only — the route-derived alias and the
// guards that depend on it, the space-name lookup, and the compress-task
// auto-download that personal lacks.

import { describe, expect, it } from 'vitest'
import { FIXTURE_FILES, installWindowStub, mount, urlSegments } from '../files/testing/file-browser-harness'
import { BrowserApi, describeFileBrowserContract } from '../files/testing/file-browser-contract'
import { SpaceFilesComponent } from './space-files.component'

const ALIAS = 'demo'
const USER_ID = 7

describeFileBrowserContract({
  label: 'space-files',
  ctor: SpaceFilesComponent,
  // Space-files reads its alias from the route — the whole point of the seam.
  alias: ALIAS,
  routeParams: { alias: ALIAS },
  viewModeKey: 'ui.space.viewMode',
  folderRoute: (segs, name) => ['/', 'v2', 'spaces', ALIAS, ...segs, name],
  // The Spaces index deliberately has NO targetPath: you cannot drop a file
  // onto "the list of spaces".
  rootBreadcrumbs: [
    { label: 'Spaces', icon: 'box', route: ['/', 'v2', 'spaces'] },
    { label: ALIAS, route: ['/', 'v2', 'spaces', ALIAS], targetPath: `files/${ALIAS}` }
  ],
  nestedBreadcrumbs: (segs) => [
    { label: 'Spaces', icon: 'box', route: ['/', 'v2', 'spaces'] },
    { label: ALIAS, route: ['/', 'v2', 'spaces', ALIAS], targetPath: `files/${ALIAS}` },
    ...segs.map((seg, i) => ({
      label: seg,
      route: ['/', 'v2', 'spaces', ALIAS, ...segs.slice(0, i + 1)],
      targetPath: [`files/${ALIAS}`, ...segs.slice(0, i + 1)].join('/')
    }))
  ],
  // Space files DO carry a space descriptor and DELIBERATELY send ownerId: null
  // even when a user is logged in. Personal is the exact inverse.
  dialogSpace: { alias: ALIAS, name: ALIAS, root: { alias: ALIAS, name: ALIAS } },
  dialogOwnerId: null,
  compressRootAlias: ALIAS,
  rootArchiveName: ALIAS,
  userId: USER_ID,
  // The extra listSpaces call is the space-name lookup fired from the listing's
  // success handler.
  navSequence: ['breadcrumbs.set', 'folderSize.clear', 'http.get', 'spaces.listSpaces', 'favorites.loadFavoriteIds'],
  // Space-files' onFabSheetSelect closes the sheet before dispatching.
  fabSheetClosesOnSelect: true
})

describe('space-files browser — space-only behaviour', () => {
  const start = (segs: string[] = [], alias: string = ALIAS, spaces: { alias: string; name: string }[] = []) => {
    const res = mount(SpaceFilesComponent, (deps) => {
      deps.routeParams.next(alias ? { alias } : {})
      deps.routeUrl.next(urlSegments(...segs))
      deps.httpGetResponses.set(['/api/app/spaces/browse/files', alias, ...segs].join('/'), { files: FIXTURE_FILES })
      deps.user.next({ id: USER_ID })
      deps.spaces.next(spaces)
    })
    const c = res.component as BrowserApi
    c.ngOnInit()
    res.flush()
    return { ...res, c }
  }

  describe('alias resolution', () => {
    it('derives the browse URL from the route param', () => {
      const { deps } = start([], 'other-space')
      expect(deps.log.only('http.get').args[0]).toBe('/api/app/spaces/browse/files/other-space')
    })

    it('reloads when either the params or the url change', () => {
      const { deps } = start()
      deps.routeUrl.next(urlSegments('sub'))
      expect(deps.log.count('http.get')).toBe(2)
      deps.routeParams.next({ alias: 'another' })
      expect(deps.log.count('http.get')).toBe(3)
      expect(deps.log.of('http.get')[2].args[0]).toBe('/api/app/spaces/browse/files/another/sub')
    })

    it('issues no request at all without an alias', () => {
      const { deps } = start([], '')
      expect(deps.log.count('http.get')).toBe(0)
      expect(deps.log.count('breadcrumbs.set')).toBe(0)
    })

    it('refuses to navigate, comment or star without an alias', () => {
      const { c, deps } = start([], '')
      c.openEntry(FIXTURE_FILES[1])
      c.openEntry(FIXTURE_FILES[0])
      c.openComments(FIXTURE_FILES[0])
      c.toggleFavorite(FIXTURE_FILES[0])
      expect(deps.log.count('router.navigate')).toBe(0)
      expect(deps.log.count('favorites.toggle')).toBe(0)
    })

    it('refuses a middle-click new tab without an alias', () => {
      const { win, restore } = installWindowStub()
      try {
        const { c } = start([], '')
        c.onRowAuxClick({ button: 1, preventDefault: () => undefined } as unknown as MouseEvent, FIXTURE_FILES[0])
        expect(win.opened).toEqual([])
      } finally {
        restore()
      }
    })

    it('publishes nothing to the dock without an alias', () => {
      const { c, deps, flush } = start([], '')
      c.files.set(FIXTURE_FILES)
      c.toggleSelection(FIXTURE_FILES[0])
      flush()
      expect(deps.dockSelected()).toBeNull()
    })
  })

  describe('space name', () => {
    it('looks the space name up once the listing lands and re-publishes the breadcrumbs', () => {
      const { c, deps } = start([], ALIAS, [{ alias: ALIAS, name: 'Demo Space' }])
      expect(c.spaceName()).toBe('Demo Space')
      expect(deps.log.of('breadcrumbs.set').at(-1)!.args[0]).toEqual([
        { label: 'Spaces', icon: 'box', route: ['/', 'v2', 'spaces'] },
        { label: 'Demo Space', route: ['/', 'v2', 'spaces', ALIAS], targetPath: `files/${ALIAS}` }
      ])
    })

    it('falls back to the alias when the space list has no match', () => {
      const { c } = start([], ALIAS, [{ alias: 'someone-else', name: 'Nope' }])
      expect(c.spaceName()).toBe('')
      expect(c.folderLabel()).toBe(ALIAS)
    })

    it('falls back to the alias when the space has an empty name', () => {
      const { c } = start([], ALIAS, [{ alias: ALIAS, name: '' }])
      expect(c.spaceName()).toBe(ALIAS)
    })

    it('titles the root with the space name and a nested folder with its own name', () => {
      const root = start([], ALIAS, [{ alias: ALIAS, name: 'Demo Space' }])
      expect(root.c.folderLabel()).toBe('Demo Space')
      const nested = start(['sub', 'deeper'], ALIAS, [{ alias: ALIAS, name: 'Demo Space' }])
      expect(nested.c.folderLabel()).toBe('deeper')
    })

    it('stops looking the name up once it is known', () => {
      const { c, deps } = start([], ALIAS, [{ alias: ALIAS, name: 'Demo Space' }])
      expect(deps.log.count('spaces.listSpaces')).toBe(1)
      c.refresh()
      expect(deps.log.count('spaces.listSpaces')).toBe(1)
    })

    it('carries the resolved space name into the link and share DTOs', async () => {
      const { c, deps } = start(['sub'], ALIAS, [{ alias: ALIAS, name: 'Demo Space' }])
      await c.getLink(FIXTURE_FILES[0])
      expect(deps.log.only('linkDialog.open').args[0]).toEqual({
        file: {
          id: 1,
          name: 'alpha.txt',
          isDir: false,
          mime: 'text/plain',
          space: { alias: ALIAS, name: 'Demo Space', root: { alias: ALIAS, name: 'Demo Space' } }
        },
        relativePath: 'sub/alpha.txt',
        ownerId: null
      })
    })

    it('seeds the root archive name from the resolved space name', async () => {
      const { c, deps } = start([], ALIAS, [{ alias: ALIAS, name: 'Demo Space' }])
      c.toggleSelection(FIXTURE_FILES[0])
      c.toggleSelection(FIXTURE_FILES[2])
      c.bulkDownload()
      await Promise.resolve()
      expect(deps.log.only('compressDialog.open').args[0]).toMatchObject({ initialValue: 'Demo Space' })
    })
  })

  describe('compress task auto-download', () => {
    it('downloads the archive as soon as the task reports one', () => {
      const { deps } = start()
      deps.filesOnEvent.next({ archiveId: 'task-42' })
      expect(deps.log.only('files.downloadTaskArchive').args).toEqual(['task-42'])
    })

    it('ignores task events with no archive', () => {
      const { deps } = start()
      deps.filesOnEvent.next({ filePath: 'files/elsewhere' })
      expect(deps.log.count('files.downloadTaskArchive')).toBe(0)
    })
  })

  describe('filter shortcut', () => {
    // #368: this asserted the opposite until the gap was closed. The template
    // rendered a hard-coded "⌘F" hint with no handler behind it, so the key
    // fell through to the browser's own find-in-page.
    it('wires cmd/ctrl-F to the filter input and preempts the browser', () => {
      const { c } = start()
      const calls: string[] = []
      c.filterInput = { nativeElement: { focus: () => calls.push('focus'), select: () => calls.push('select') } }
      let prevented = 0
      c.onWindowKeydown({ key: 'f', metaKey: true, target: {}, preventDefault: () => prevented++ } as unknown as KeyboardEvent)
      expect(calls).toEqual(['focus', 'select'])
      expect(prevented).toBe(1)
    })

    it('advertises the same platform-aware hint personal does, not a hard-coded glyph', () => {
      const { c } = start()
      expect(c.repository.filterHint()).toBe((c as unknown as { filterShortcutLabel: string }).filterShortcutLabel)
      expect(['⌘F', 'Ctrl F']).toContain(c.repository.filterHint())
    })
  })

  describe('creation dispatch', () => {
    it('closes the action sheet, then dispatches through the shared handler', () => {
      const { c, deps } = start(['sub'])
      c.fabSheetOpen.set(true)
      c.onFabSheetSelect('new-pptx')
      expect(c.fabSheetOpen()).toBe(false)
      expect(deps.log.only('files.make').args).toEqual(['file', 'Untitled.pptx', `files/${ALIAS}/sub`, true])
    })

    it('routes the action-sheet Upload entry to the file picker without dispatching a create', () => {
      const { c, deps } = start()
      const input = {
        value: '',
        clicked: 0,
        click() {
          this.clicked++
        }
      }
      c.fileInput = { nativeElement: input }
      c.onFabSheetSelect('upload')
      expect(input.clicked).toBe(1)
      expect(deps.log.count('files.make')).toBe(0)
    })
  })
})
