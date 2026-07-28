// Behavioural pin for the v2 "Personal" file browser.
//
// The bulk of the surface is asserted by the shared contract below; the
// `describe` blocks after it cover what is genuinely personal-only. Together
// with space-files.component.spec.ts these two files are the specification of
// the repository-strategy seam that issue #346 consolidates behind.

import { describe, expect, it } from 'vitest'
import { FIXTURE_FILES, installWindowStub, mount, urlSegments } from '../files/testing/file-browser-harness'
import { BrowserApi, describeFileBrowserContract } from '../files/testing/file-browser-contract'
import { PersonalComponent } from './personal.component'

const USER_ID = 7

describeFileBrowserContract({
  label: 'personal',
  ctor: PersonalComponent,
  // Personal's alias is the SPACE_ALIAS.PERSONAL constant — never route-derived.
  alias: 'personal',
  routeParams: {},
  viewModeKey: 'ui.personal.viewMode',
  folderRoute: (segs, name) => ['/', 'v2', 'personal', ...segs, name],
  rootBreadcrumbs: [{ label: 'Personal', icon: 'folder', route: ['/', 'v2', 'personal'], targetPath: 'files/personal' }],
  nestedBreadcrumbs: (segs) => [
    { label: 'Personal', icon: 'folder', route: ['/', 'v2', 'personal'], targetPath: 'files/personal' },
    ...segs.map((seg, i) => ({
      label: seg,
      route: ['/', 'v2', 'personal', ...segs.slice(0, i + 1)],
      targetPath: ['files/personal', ...segs.slice(0, i + 1)].join('/')
    }))
  ],
  // Personal files carry NO space object and DO carry the owner id. space-files
  // is the exact inverse — see that spec. Preserved verbatim by #346.
  dialogSpace: null,
  dialogOwnerId: USER_ID,
  compressRootAlias: 'personal',
  rootArchiveName: 'personal',
  userId: USER_ID,
  navSequence: ['breadcrumbs.set', 'folderSize.clear', 'http.get', 'favorites.loadFavoriteIds'],
  // Personal's onFabSheetSelect has its own switch and never closes the sheet.
  fabSheetClosesOnSelect: false
})

describe('personal file browser — personal-only behaviour', () => {
  const start = (segs: string[] = []) => {
    const res = mount(PersonalComponent, (deps) => {
      deps.routeUrl.next(urlSegments(...segs))
      deps.httpGetResponses.set(['/api/app/spaces/browse/files/personal', ...segs].join('/'), { files: FIXTURE_FILES })
      deps.user.next({ id: USER_ID })
    })
    const c = res.component as BrowserApi
    c.ngOnInit()
    res.flush()
    return { ...res, c }
  }

  it('titles the root folder "Personal" without consulting the server', () => {
    const { c, deps } = start()
    expect(c.folderLabel()).toBe('Personal')
    expect(deps.log.count('spaces.listSpaces')).toBe(0)
  })

  it('titles a nested folder with its own name', () => {
    const { c } = start(['sub', 'deeper'])
    expect(c.folderLabel()).toBe('deeper')
  })

  it('focuses and selects the filter input on cmd/ctrl-F', () => {
    const { c } = start()
    const calls: string[] = []
    c.filterInput = { nativeElement: { focus: () => calls.push('focus'), select: () => calls.push('select') } }
    let prevented = 0
    c.onWindowKeydown({ key: 'f', metaKey: true, target: {}, preventDefault: () => prevented++ } as unknown as KeyboardEvent)
    expect(calls).toEqual(['focus', 'select'])
    expect(prevented).toBe(1)
  })

  it('honours cmd/ctrl-F even while focus sits in another text field', () => {
    // The kbd badge next to the filter promises the shortcut from anywhere, so
    // the handler runs before the "typing in an input" bail-out.
    const { c } = start()
    const calls: string[] = []
    c.filterInput = { nativeElement: { focus: () => calls.push('focus'), select: () => calls.push('select') } }
    const target = new (globalThis as Record<string, any>)['HTMLInputElement']()
    c.onWindowKeydown({ key: 'F', ctrlKey: true, target, preventDefault: () => undefined } as unknown as KeyboardEvent)
    expect(calls).toEqual(['focus', 'select'])
  })

  it('falls through when the filter input is not rendered', () => {
    const { c } = start()
    c.toggleSelection(FIXTURE_FILES[0])
    let prevented = 0
    c.onWindowKeydown({ key: 'f', metaKey: true, target: {}, preventDefault: () => prevented++ } as unknown as KeyboardEvent)
    expect(prevented).toBe(0)
    expect(c.hasSelection()).toBe(true)
  })

  it('labels the shortcut hint from the platform', () => {
    // Node exposes a real `navigator`, and its `platform` differs between a
    // developer Mac and Linux CI — so drive both branches explicitly rather
    // than asserting whatever the host happens to report.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    const withNavigator = (value: unknown) => {
      Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true })
      const res = mount(PersonalComponent, (deps) => deps.routeUrl.next(urlSegments()))
      return (res.component as BrowserApi).filterShortcutLabel
    }
    try {
      expect(withNavigator({ platform: 'MacIntel', userAgent: '' })).toBe('⌘F')
      expect(withNavigator({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' })).toBe('⌘F')
      expect(withNavigator({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' })).toBe('Ctrl F')
      expect(withNavigator({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe('Ctrl F')
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original)
    }
  })

  it('does NOT auto-download a finished compress task', () => {
    // space-files subscribes to filesOnEvent.archiveId and calls
    // downloadTaskArchive; personal has no such subscription. #346 preserves
    // this verbatim — see the PR body, it is very likely a bug in personal.
    const { deps } = start()
    deps.filesOnEvent.next({ archiveId: 'task-1', filePath: 'files/personal' })
    expect(deps.log.count('files.downloadTaskArchive')).toBe(0)
  })

  it('never reads the route params — the alias is a constant', () => {
    const res = mount(PersonalComponent, (deps) => {
      deps.routeParams.next({ alias: 'ignored-space' })
      deps.routeUrl.next(urlSegments())
      deps.httpGetResponses.set('/api/app/spaces/browse/files/personal', { files: FIXTURE_FILES })
    })
    const c = res.component as BrowserApi
    c.ngOnInit()
    expect(res.deps.log.only('http.get').args[0]).toBe('/api/app/spaces/browse/files/personal')
  })

  it('reloads on every url emission', () => {
    const { deps } = start()
    deps.routeUrl.next(urlSegments('sub'))
    expect(deps.log.count('http.get')).toBe(2)
    expect(deps.log.of('http.get')[1].args[0]).toBe('/api/app/spaces/browse/files/personal/sub')
  })

  it('dispatches each action-sheet id to its own creation handler', () => {
    const cases: [string, unknown[]][] = [
      ['new-folder', ['directory']],
      ['new-text', ['file']],
      ['new-docx', ['file', 'Untitled.docx']],
      ['new-xlsx', ['file', 'Untitled.xlsx']],
      ['new-pptx', ['file', 'Untitled.pptx']]
    ]
    for (const [id, expected] of cases) {
      const { c, deps } = start()
      c.onFabSheetSelect(id)
      if (expected.length === 1) {
        // Folder/text open a prompt first; nothing is created until it resolves.
        expect(deps.log.count('promptDialog.open')).toBe(1)
      } else {
        expect(deps.log.only('files.make').args.slice(0, 2)).toEqual(expected)
      }
    }
  })

  it('routes the action-sheet Download-from-URL entry to the two-step prompt', () => {
    const { c, deps } = start()
    c.onFabSheetSelect('new-download-url')
    expect(deps.log.only('promptDialog.open').args[0]).toMatchObject({ title: 'Download from URL' })
  })

  it('ignores an unknown action-sheet id', () => {
    const { c, deps } = start()
    deps.log.clear()
    c.onFabSheetSelect('not-a-thing')
    expect(deps.log.calls.length).toBe(0)
  })

  it('opens the personal file-detail URL on middle-click', () => {
    const { win, restore } = installWindowStub()
    try {
      const { c } = start(['sub'])
      c.onRowAuxClick({ button: 1, preventDefault: () => undefined } as unknown as MouseEvent, FIXTURE_FILES[0])
      expect(win.opened[0].url).toBe(`/#/v2/file?path=${encodeURIComponent('files/personal/sub/alpha.txt')}`)
    } finally {
      restore()
    }
  })
})
