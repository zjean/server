// The behavioural contract shared by the two v2 file-browser screens.
//
// Both screens are driven through the same ~61 methods. This suite pins what
// each of those methods DOES — which backend call, with which URL / DTO /
// sentinel value, and which state transition — and takes the per-screen answers
// as *data* (`BrowserContractParams`), so a divergence in the data is asserted
// rather than papered over.
//
// Everything that is genuinely screen-specific (space-name lookup, empty-alias
// guards, the ⌘F handler, the archive auto-download) lives in the per-screen
// spec files next to the components, not here.
//
// Read this file top-to-bottom as the specification of the "repository strategy"
// seam: every place a param is dereferenced is a place the two screens differ.

import { describe, expect, it } from 'vitest'
import type { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { FILE_OPERATION } from '@sync-in-server/backend/src/applications/files/constants/operations'
import { API_FILES_OPERATION } from '@sync-in-server/backend/src/applications/files/constants/routes'
import { file, FIXTURE_FILES, HarnessDeps, installWindowStub, mount, urlSegments } from './file-browser-harness'

/** The members these specs drive. The real ones are `protected`/`private`. */
export type BrowserApi = Record<string, any>

export interface BrowserContractParams {
  /** Name used in the describe() block. */
  label: string
  ctor: new () => unknown
  /** Repository alias segment: `files/<alias>/...` in every server path. */
  alias: string
  /** Route params to seed before mount (space-files reads `alias` from them). */
  routeParams: Record<string, string>
  /** localStorage key holding the view mode. Deliberately different per screen. */
  viewModeKey: string
  /** Router commands for navigating INTO a folder. */
  folderRoute: (segs: string[], name: string) => unknown[]
  /** Expected breadcrumb array at the repository root. */
  rootBreadcrumbs: unknown[]
  /** Expected breadcrumb array for a nested path. */
  nestedBreadcrumbs: (segs: string[]) => unknown[]
  /** `space` field handed to the link/share dialogs. */
  dialogSpace: unknown
  /** `ownerId` handed to the link/share dialogs. */
  dialogOwnerId: number | null
  /** `rootAlias` inside each entry of the compress DTO. */
  compressRootAlias: string
  /** Default archive name offered at the repository root. */
  rootArchiveName: string
  /** Id of the logged-in user seeded into StoreService. */
  userId: number
  /** Login of the logged-in user seeded into StoreService — what the lock flow compares against. */
  userLogin: string
  /**
   * `repository.filesAreOwnedByUser` — whether the screen asserts file ownership
   * by construction (personal) or defers to the row's `root.owner` (a space).
   * Drives both halves of the unlock flow: whether Unlock is offered at all and
   * whether the request carries `forceAsFileOwner=true`.
   */
  filesAreOwnedByUser: boolean
  /** Recorded side effects of one navigation, excluding the ngOnInit prologue. */
  navSequence: string[]
  /** Does `onFabSheetSelect` close the sheet itself? */
  fabSheetClosesOnSelect: boolean
}

const BROWSE = '/api/app/spaces/browse'
const OPERATION = API_FILES_OPERATION

export function describeFileBrowserContract(p: BrowserContractParams): void {
  const seed = (deps: HarnessDeps, segs: string[] = [], files: FileProps[] = FIXTURE_FILES) => {
    deps.routeParams.next(p.routeParams)
    deps.routeUrl.next(urlSegments(...segs))
    deps.httpGetResponses.set([BROWSE, 'files', p.alias, ...segs].join('/'), { files })
    deps.user.next({ id: p.userId, login: p.userLogin })
  }

  /** Mount + ngOnInit at `segs`, with the listing already stubbed. */
  const start = (segs: string[] = [], files: FileProps[] = FIXTURE_FILES) => {
    const res = mount(p.ctor as new () => unknown, (deps) => seed(deps, segs, files))
    const c = res.component as BrowserApi
    c.ngOnInit()
    res.flush()
    return { ...res, c }
  }

  const dirPath = (segs: string[] = []) => ['files', p.alias, ...segs].join('/')
  const filePath = (name: string, segs: string[] = []) => ['files', p.alias, ...segs, name].join('/')

  describe(`${p.label} file browser contract`, () => {
    // -----------------------------------------------------------------------
    // A. Listing
    // -----------------------------------------------------------------------
    describe('listing', () => {
      it('GETs the spaces-browse URL for the repository root', () => {
        const { deps } = start()
        expect(deps.log.only('http.get').args[0]).toBe(`${BROWSE}/files/${p.alias}`)
      })

      it('appends the path segments to the browse URL', () => {
        const { deps } = start(['sub', 'deeper'])
        expect(deps.log.only('http.get').args[0]).toBe(`${BROWSE}/files/${p.alias}/sub/deeper`)
      })

      it('populates files() and clears loading on success', () => {
        const { c } = start()
        expect(c.files().map((f: FileProps) => f.id)).toEqual([1, 2, 3, 4])
        expect(c.loading()).toBe(false)
        expect(c.errorMessage()).toBeNull()
      })

      it('reports "Folder not found" on 404 and empties the listing', () => {
        const res = mount(p.ctor as new () => unknown, (deps) => {
          seed(deps)
          deps.httpGetError = 404
        })
        const c = res.component as BrowserApi
        c.ngOnInit()
        expect(c.files()).toEqual([])
        expect(c.errorMessage()).toBe('Folder not found')
        expect(c.loading()).toBe(false)
      })

      it('reports "Failed to load folder" on any other status', () => {
        const res = mount(p.ctor as new () => unknown, (deps) => {
          seed(deps)
          deps.httpGetError = 500
        })
        const c = res.component as BrowserApi
        c.ngOnInit()
        expect(c.errorMessage()).toBe('Failed to load folder')
      })

      it('runs the per-navigation sequence: breadcrumbs, folder-size reset, listing, favorites', () => {
        const { deps } = start()
        const seq = deps.log.sequence()
        expect(seq.slice(0, 2)).toEqual(['dock.setTabs', 'drag.registerDropHandler'])
        // clearSelection() is a no-op with an empty selection, so it records nothing.
        expect(seq.filter((s) => s !== 'dock.setTabs' && s !== 'drag.registerDropHandler')).toEqual(p.navSequence)
      })

      it('refresh() re-issues the same listing request', () => {
        const { c, deps } = start(['sub'])
        c.refresh()
        expect(deps.log.count('http.get')).toBe(2)
        expect(deps.log.of('http.get')[1].args[0]).toBe(`${BROWSE}/files/${p.alias}/sub`)
      })

      it('reloads when a task event names this folder, and ignores other folders', () => {
        const { deps } = start(['sub'])
        deps.filesOnEvent.next({ filePath: 'files/somewhere/else' })
        expect(deps.log.count('http.get')).toBe(1)
        deps.filesOnEvent.next({ filePath: dirPath(['sub']) })
        expect(deps.log.count('http.get')).toBe(2)
        deps.filesOnEvent.next({ fileDstPath: dirPath(['sub']) })
        expect(deps.log.count('http.get')).toBe(3)
        deps.filesOnEvent.next(null)
        expect(deps.log.count('http.get')).toBe(3)
      })

      it('releases its drop handler, folder sizes and dock on destroy', () => {
        const { c, deps } = start()
        deps.log.clear()
        c.ngOnDestroy()
        expect(deps.log.sequence()).toEqual(['drag.unregisterDropHandler', 'folderSize.clear', 'dock.clear'])
      })
    })

    // -----------------------------------------------------------------------
    // B. Breadcrumbs
    // -----------------------------------------------------------------------
    describe('breadcrumbs', () => {
      it('publishes the root trail', () => {
        const { deps } = start()
        expect(deps.log.of('breadcrumbs.set').at(-1)!.args[0]).toEqual(p.rootBreadcrumbs)
      })

      it('publishes a nested trail with a drop target per segment', () => {
        const { deps } = start(['sub', 'deeper'])
        expect(deps.log.of('breadcrumbs.set').at(-1)!.args[0]).toEqual(p.nestedBreadcrumbs(['sub', 'deeper']))
      })
    })

    // -----------------------------------------------------------------------
    // C. Navigation
    // -----------------------------------------------------------------------
    describe('navigation', () => {
      it('navigates into a folder using the screen route', () => {
        const { c, deps } = start(['sub'])
        c.openEntry(FIXTURE_FILES[1])
        expect(deps.log.only('router.navigate').args[0]).toEqual(p.folderRoute(['sub'], 'beta'))
      })

      it('opens a file in the v2 file-detail route with an absolute repository path', () => {
        const { c, deps } = start(['sub'])
        c.openEntry(FIXTURE_FILES[0])
        const call = deps.log.only('router.navigate')
        expect(call.args[0]).toEqual(['/', 'v2', 'file'])
        expect(call.args[1]).toEqual({ queryParams: { path: filePath('alpha.txt', ['sub']) } })
      })

      it('opens comments on the same route with tab=comment, and never for a folder', () => {
        const { c, deps } = start()
        c.openComments(FIXTURE_FILES[1])
        expect(deps.log.count('router.navigate')).toBe(0)
        c.openComments(FIXTURE_FILES[0])
        expect(deps.log.only('router.navigate').args[1]).toEqual({ queryParams: { path: filePath('alpha.txt'), tab: 'comment' } })
      })

      it('middle-click opens a background tab for files only', () => {
        const { win, restore } = installWindowStub()
        try {
          const { c } = start(['sub'])
          const prevented: string[] = []
          const ev = (button: number) => ({ button, preventDefault: () => prevented.push('x') }) as unknown as MouseEvent
          c.onRowAuxClick(ev(0), FIXTURE_FILES[0])
          expect(win.opened).toEqual([])
          c.onRowAuxClick(ev(1), FIXTURE_FILES[1])
          expect(win.opened).toEqual([])
          c.onRowAuxClick(ev(1), FIXTURE_FILES[0])
          expect(win.opened).toEqual([
            { url: `/#/v2/file?path=${encodeURIComponent(filePath('alpha.txt', ['sub']))}`, target: '_blank', features: 'noopener' }
          ])
          expect(prevented.length).toBe(1)
        } finally {
          restore()
        }
      })
    })

    // -----------------------------------------------------------------------
    // D. Selection
    // -----------------------------------------------------------------------
    describe('selection', () => {
      it('toggles a row in and out of the selection', () => {
        const { c } = start()
        expect(c.isSelected(FIXTURE_FILES[0])).toBe(false)
        c.toggleSelection(FIXTURE_FILES[0])
        expect(c.isSelected(FIXTURE_FILES[0])).toBe(true)
        expect(c.selectionCount()).toBe(1)
        c.toggleSelection(FIXTURE_FILES[0])
        expect(c.hasSelection()).toBe(false)
      })

      it('a plain click on nothing-selected opens the row', () => {
        const { c, deps } = start()
        c.onRowClick({ shiftKey: false, metaKey: false, ctrlKey: false } as MouseEvent, FIXTURE_FILES[0])
        expect(deps.log.count('router.navigate')).toBe(1)
      })

      it('a plain click while another row is selected re-selects instead of opening', () => {
        const { c, deps } = start()
        c.toggleSelection(FIXTURE_FILES[0])
        deps.log.clear()
        c.onRowClick({ shiftKey: false, metaKey: false, ctrlKey: false } as MouseEvent, FIXTURE_FILES[2])
        expect(deps.log.count('router.navigate')).toBe(0)
        expect([...c.selection()]).toEqual([3])
      })

      it('a plain click on the only selected row opens it', () => {
        const { c, deps } = start()
        c.toggleSelection(FIXTURE_FILES[0])
        deps.log.clear()
        c.onRowClick({ shiftKey: false, metaKey: false, ctrlKey: false } as MouseEvent, FIXTURE_FILES[0])
        expect(deps.log.count('router.navigate')).toBe(1)
      })

      it('meta/ctrl click toggles without opening', () => {
        const { c, deps } = start()
        c.onRowClick({ metaKey: true } as MouseEvent, FIXTURE_FILES[0])
        c.onRowClick({ ctrlKey: true } as MouseEvent, FIXTURE_FILES[2])
        expect(deps.log.count('router.navigate')).toBe(0)
        expect([...c.selection()].sort()).toEqual([1, 3])
      })

      it('shift click extends from the anchor over the filtered order', () => {
        const { c } = start()
        c.toggleSelection(FIXTURE_FILES[0])
        c.onRowClick({ shiftKey: true } as MouseEvent, FIXTURE_FILES[2])
        expect([...c.selection()].sort()).toEqual([1, 2, 3])
      })

      it('shift click with a stale anchor falls back to a single selection', () => {
        const { c } = start()
        c.toggleSelection(FIXTURE_FILES[0])
        c.filter.set('gamma')
        c.onRowClick({ shiftKey: true } as MouseEvent, FIXTURE_FILES[2])
        expect([...c.selection()]).toEqual([3])
      })

      it('select-all covers only the filtered rows and toggles back off', () => {
        const { c } = start()
        c.filter.set('ta')
        c.toggleSelectAll()
        expect(c.selectAllState()).toBe('checked')
        expect([...c.selection()].sort()).toEqual([2, 4])
        c.toggleSelectAll()
        expect(c.hasSelection()).toBe(false)
      })

      it('reports an indeterminate select-all state for a partial selection', () => {
        const { c } = start()
        c.toggleSelection(FIXTURE_FILES[0])
        expect(c.selectAllState()).toBe('indeterminate')
      })

      it('drops selected ids that leave the listing', () => {
        const { c, flush } = start()
        c.toggleSelection(FIXTURE_FILES[0])
        c.toggleSelection(FIXTURE_FILES[2])
        flush()
        c.files.set([FIXTURE_FILES[2]])
        flush()
        expect([...c.selection()]).toEqual([3])
      })

      it('sums sizes for the listing and the selection, counting folders as zero', () => {
        const { c } = start()
        expect(c.totalSize()).toBe(10 + 200 + 300)
        c.toggleSelection(FIXTURE_FILES[1])
        c.toggleSelection(FIXTURE_FILES[2])
        expect(c.selectionSize()).toBe(200)
      })

      it('flags a selection that already contains a shared file', () => {
        const shared = file({ id: 9, name: 'shared.txt', shares: [{ id: 1 }] } as never)
        const { c } = start([], [...FIXTURE_FILES, shared])
        c.toggleSelection(FIXTURE_FILES[0])
        expect(c.selectionHasShares()).toBe(false)
        c.toggleSelection(shared)
        expect(c.selectionHasShares()).toBe(true)
      })

      it('publishes exactly one selected row to the dock and clears it for multi-select', () => {
        const { c, deps, flush } = start(['sub'])
        c.toggleSelection(FIXTURE_FILES[0])
        flush()
        expect(deps.dockSelected()).toEqual({
          id: 1,
          name: 'alpha.txt',
          path: filePath('alpha.txt', ['sub']),
          mime: 'text/plain',
          size: 10,
          isDir: false,
          mtime: FIXTURE_FILES[0].mtime,
          ctime: FIXTURE_FILES[0].ctime
        })
        c.toggleSelection(FIXTURE_FILES[2])
        flush()
        expect(deps.dockSelected()).toBeNull()
      })
    })

    // -----------------------------------------------------------------------
    // E. Filter + keyboard
    // -----------------------------------------------------------------------
    describe('filter and keyboard', () => {
      it('filters case-insensitively on a name substring', () => {
        const { c } = start()
        c.onFilterInput({ target: { value: 'GAM' } } as unknown as Event)
        expect(c.filter()).toBe('GAM')
        expect(c.filteredFiles().map((f: FileProps) => f.id)).toEqual([3])
      })

      it('an empty filter passes the listing through untouched', () => {
        const { c } = start()
        c.filter.set('   ')
        expect(c.filteredFiles().length).toBe(4)
      })

      it('Escape clears a selection', () => {
        const { c } = start()
        c.toggleSelection(FIXTURE_FILES[0])
        let prevented = 0
        c.onWindowKeydown({ key: 'Escape', target: {}, preventDefault: () => prevented++ } as unknown as KeyboardEvent)
        expect(c.hasSelection()).toBe(false)
        expect(prevented).toBe(1)
      })

      it('ctrl/cmd-A selects every filtered row', () => {
        const { c } = start()
        c.filter.set('ta')
        c.onWindowKeydown({ key: 'a', metaKey: true, target: {}, preventDefault: () => undefined } as unknown as KeyboardEvent)
        expect([...c.selection()].sort()).toEqual([2, 4])
      })

      it('Delete and Backspace both ask to move the selection to trash', async () => {
        for (const key of ['Delete', 'Backspace']) {
          const { c, deps } = start()
          c.toggleSelection(FIXTURE_FILES[0])
          c.onWindowKeydown({ key, target: {}, preventDefault: () => undefined } as unknown as KeyboardEvent)
          await Promise.resolve()
          expect(deps.log.count('confirmDialog.open')).toBe(1)
        }
      })

      it('ignores keys typed into a text field', () => {
        const { c } = start()
        c.toggleSelection(FIXTURE_FILES[0])
        const target = new (globalThis as Record<string, any>)['HTMLInputElement']()
        c.onWindowKeydown({ key: 'Escape', target, preventDefault: () => undefined } as unknown as KeyboardEvent)
        expect(c.hasSelection()).toBe(true)
      })

      it('does nothing on Delete with no selection', () => {
        const { c, deps } = start()
        c.onWindowKeydown({ key: 'Delete', target: {}, preventDefault: () => undefined } as unknown as KeyboardEvent)
        expect(deps.log.count('confirmDialog.open')).toBe(0)
      })
    })

    // -----------------------------------------------------------------------
    // F. View mode
    // -----------------------------------------------------------------------
    describe('view mode', () => {
      it('reads the initial mode from its own localStorage key', () => {
        const { win, restore } = installWindowStub({ [p.viewModeKey]: 'gallery' })
        try {
          const res = mount(p.ctor as new () => unknown, (deps) => seed(deps))
          expect((res.component as BrowserApi).mode()).toBe('gallery')
          expect(win.storage.get(p.viewModeKey)).toBe('gallery')
        } finally {
          restore()
        }
      })

      it('falls back to list for an unknown stored value', () => {
        const { restore } = installWindowStub({ [p.viewModeKey]: 'nonsense' })
        try {
          const res = mount(p.ctor as new () => unknown, (deps) => seed(deps))
          expect((res.component as BrowserApi).mode()).toBe('list')
        } finally {
          restore()
        }
      })

      it('persists a mode change to its own key', () => {
        const { win, restore } = installWindowStub()
        try {
          const { c } = start()
          c.setMode('grid')
          expect(c.mode()).toBe('grid')
          expect(win.storage.get(p.viewModeKey)).toBe('grid')
        } finally {
          restore()
        }
      })
    })

    // -----------------------------------------------------------------------
    // G. Destructive operations
    // -----------------------------------------------------------------------
    describe('delete', () => {
      it('asks before deleting one row and does nothing when declined', async () => {
        const { c, deps } = start()
        await c.confirmAndDelete(FIXTURE_FILES[0])
        expect(deps.log.only('confirmDialog.open').args[0]).toEqual({
          title: 'Move to trash',
          message: 'v2_move_to_trash_one',
          messageParams: { name: 'alpha.txt' },
          confirmLabel: 'Move to trash',
          kind: 'danger'
        })
        expect(deps.log.count('files.delete')).toBe(0)
      })

      it('deletes one row with a stub carrying the absolute repository path', async () => {
        const { c, deps } = start(['sub'], FIXTURE_FILES)
        deps.confirmResults.results.push(true)
        await c.confirmAndDelete(FIXTURE_FILES[0])
        const stubs = deps.log.only('files.delete').args[0] as { path: string; name: string }[]
        expect(stubs.length).toBe(1)
        expect(stubs[0].path).toBe(filePath('alpha.txt', ['sub']))
        expect(stubs[0].name).toBe('alpha.txt')
        expect(deps.log.only('toast.success').args).toEqual(['v2_moving_to_trash_one_progress', { name: 'alpha.txt' }])
      })

      it('bulk-deletes the selection with the plural confirm and toast', async () => {
        const { c, deps } = start()
        c.toggleSelection(FIXTURE_FILES[0])
        c.toggleSelection(FIXTURE_FILES[2])
        deps.confirmResults.results.push(true)
        await c.bulkDelete()
        expect(deps.log.only('confirmDialog.open').args[0]).toMatchObject({ message: 'v2_move_to_trash_n', messageParams: { nb: 2 } })
        expect((deps.log.only('files.delete').args[0] as unknown[]).length).toBe(2)
        expect(deps.log.only('toast.success').args).toEqual(['v2_moving_to_trash_n_progress', { nb: 2 }])
        expect(c.hasSelection()).toBe(false)
      })

      it('bulk-deletes a single selected row with the singular toast', async () => {
        const { c, deps } = start()
        c.toggleSelection(FIXTURE_FILES[0])
        deps.confirmResults.results.push(true)
        await c.bulkDelete()
        expect(deps.log.only('toast.success').args).toEqual(['v2_moving_to_trash_one_progress', { name: 'alpha.txt' }])
      })

      it('does nothing with an empty selection', async () => {
        const { c, deps } = start()
        await c.bulkDelete()
        expect(deps.log.count('confirmDialog.open')).toBe(0)
      })
    })

    describe('rename', () => {
      const promptFor = (deps: HarnessDeps) => deps.log.only('promptDialog.open').args[0] as Record<string, unknown>

      it('prompts with a stem selection for a file and a full selection for a folder', async () => {
        const forFile = start()
        await forFile.c.renameEntry(FIXTURE_FILES[0])
        expect(promptFor(forFile.deps)).toMatchObject({ title: 'Rename file', initialValue: 'alpha.txt', selectionRange: 'stem' })

        const forDir = start()
        await forDir.c.renameEntry(FIXTURE_FILES[1])
        expect(promptFor(forDir.deps)).toMatchObject({ title: 'Rename folder', initialValue: 'beta', selectionRange: 'all' })
      })

      it('renames with overwrite=false — the sentinel the backend reads', async () => {
        const { c, deps } = start(['sub'])
        deps.promptResults.results.push('renamed.txt')
        await c.renameEntry(FIXTURE_FILES[0])
        const call = deps.log.only('files.rename')
        expect((call.args[0] as { path: string }).path).toBe(filePath('alpha.txt', ['sub']))
        expect(call.args[1]).toBe('renamed.txt')
        expect(call.args[2]).toBe(false)
        expect(deps.log.only('toast.success').args).toEqual(['v2_renamed_to', { name: 'renamed.txt' }])
        // …then reloads the listing.
        expect(deps.log.count('http.get')).toBe(2)
      })

      it('trims the new name before sending it', async () => {
        const { c, deps } = start()
        deps.promptResults.results.push('  spaced.txt  ')
        await c.renameEntry(FIXTURE_FILES[0])
        expect(deps.log.only('files.rename').args[1]).toBe('spaced.txt')
      })

      it('skips the request when cancelled or unchanged', async () => {
        const cancelled = start()
        await cancelled.c.renameEntry(FIXTURE_FILES[0])
        expect(cancelled.deps.log.count('files.rename')).toBe(0)

        const unchanged = start()
        unchanged.deps.promptResults.results.push('  alpha.txt ')
        await unchanged.c.renameEntry(FIXTURE_FILES[0])
        expect(unchanged.deps.log.count('files.rename')).toBe(0)
      })

      it('surfaces the server message on failure and does not reload', async () => {
        const { c, deps } = start()
        deps.promptResults.results.push('renamed.txt')
        deps.renameError = { status: 409, message: 'already exists' }
        await c.renameEntry(FIXTURE_FILES[0])
        expect(deps.log.only('toast.error').args[0]).toBe('already exists')
        expect(deps.log.count('http.get')).toBe(1)
      })

      it('validates the new name against the current listing', async () => {
        const { c, deps } = start()
        await c.renameEntry(FIXTURE_FILES[0])
        const validate = promptFor(deps)['validate'] as (v: string) => string | null
        expect(validate('')).toBe('Name is required')
        expect(validate('a/b')).toBe('Name cannot contain slashes')
        expect(validate('a\\b')).toBe('Name cannot contain slashes')
        expect(validate('.')).toBe('Invalid name')
        expect(validate('..')).toBe('Invalid name')
        expect(validate('GAMMA.PDF')).toBe('A file or folder with this name already exists')
        // Its own name is always allowed — that is the "no change" case.
        expect(validate('alpha.txt')).toBeNull()
        expect(validate('brand-new.txt')).toBeNull()
      })
    })

    // -----------------------------------------------------------------------
    // H. Copy / move
    // -----------------------------------------------------------------------
    describe('copy and move', () => {
      it('offers the tree picker with the current folder disabled', async () => {
        const { c, deps } = start(['sub'])
        await c.copyOrMove(FIXTURE_FILES[0], FILE_OPERATION.MOVE)
        expect(deps.log.only('treePicker.open').args[0]).toEqual({
          title: 'Move file',
          submitLabel: 'Move here',
          disabledPath: dirPath(['sub'])
        })
      })

      it('labels the picker for a copy', async () => {
        const { c, deps } = start()
        await c.copyOrMove(FIXTURE_FILES[0], FILE_OPERATION.COPY)
        expect(deps.log.only('treePicker.open').args[0]).toMatchObject({ title: 'Copy file', submitLabel: 'Copy here' })
      })

      it('copies one row to the chosen destination', async () => {
        const { c, deps } = start(['sub'])
        deps.treePickerResults.results.push({ path: 'files/other/dst' })
        await c.copyOrMove(FIXTURE_FILES[0], FILE_OPERATION.COPY)
        const call = deps.log.only('files.copyMove')
        expect((call.args[0] as { path: string }[])[0].path).toBe(filePath('alpha.txt', ['sub']))
        expect(call.args[1]).toBe('files/other/dst')
        expect(call.args[2]).toBe(FILE_OPERATION.COPY)
        expect(deps.log.only('toast.success').args).toEqual(['v2_copying_one_progress', { name: 'alpha.txt' }])
      })

      it('does nothing when the picker is dismissed', async () => {
        const { c, deps } = start()
        await c.copyOrMove(FIXTURE_FILES[0], FILE_OPERATION.MOVE)
        expect(deps.log.count('files.copyMove')).toBe(0)
      })

      it('bulk-moves the selection and clears it', async () => {
        const { c, deps } = start()
        c.toggleSelection(FIXTURE_FILES[0])
        c.toggleSelection(FIXTURE_FILES[2])
        deps.treePickerResults.results.push({ path: 'files/other/dst' })
        await c.bulkCopyOrMove(FILE_OPERATION.MOVE)
        expect(deps.log.only('treePicker.open').args[0]).toMatchObject({ title: 'Move items', submitLabel: 'Move here' })
        expect((deps.log.only('files.copyMove').args[0] as unknown[]).length).toBe(2)
        expect(deps.log.only('toast.success').args).toEqual(['v2_moving_n_progress', { nb: 2 }])
        expect(c.hasSelection()).toBe(false)
      })

      it('bulk-copies a single row with the singular toast', async () => {
        const { c, deps } = start()
        c.toggleSelection(FIXTURE_FILES[0])
        deps.treePickerResults.results.push({ path: 'files/other/dst' })
        await c.bulkCopyOrMove(FILE_OPERATION.COPY)
        expect(deps.log.only('toast.success').args).toEqual(['v2_copying_one_progress', { name: 'alpha.txt' }])
      })

      it('does nothing with an empty selection', async () => {
        const { c, deps } = start()
        await c.bulkCopyOrMove(FILE_OPERATION.MOVE)
        expect(deps.log.count('treePicker.open')).toBe(0)
      })
    })

    // -----------------------------------------------------------------------
    // I. Drag and drop
    // -----------------------------------------------------------------------
    describe('drag and drop', () => {
      it('drags the whole selection when the grabbed row is part of it', () => {
        const { c, deps } = start(['sub'])
        c.toggleSelection(FIXTURE_FILES[0])
        c.toggleSelection(FIXTURE_FILES[2])
        const dataTransfer = { setData: (t: string, v: string) => deps.log.record('dataTransfer.setData', t, v), effectAllowed: '' }
        c.onRowDragStart({ dataTransfer } as unknown as DragEvent, FIXTURE_FILES[0])
        const call = deps.log.only('drag.start')
        expect((call.args[0] as FileProps[]).map((f) => f.id)).toEqual([1, 3])
        expect(call.args[1]).toBe(dirPath(['sub']))
        expect(deps.log.only('dataTransfer.setData').args).toEqual(['text/plain', 'alpha.txt, gamma.pdf'])
        expect(dataTransfer.effectAllowed).toBe('move')
      })

      it('drags only the grabbed row when it is outside the selection', () => {
        const { c, deps } = start()
        c.toggleSelection(FIXTURE_FILES[0])
        c.onRowDragStart({} as DragEvent, FIXTURE_FILES[2])
        expect((deps.log.only('drag.start').args[0] as FileProps[]).map((f) => f.id)).toEqual([3])
      })

      it('tracks the hovered drop target and clears it on leave', () => {
        const { c } = start()
        c.onRowDragOver({ preventDefault: () => undefined, dataTransfer: {} } as unknown as DragEvent, FIXTURE_FILES[1])
        expect(c.dropHoverId()).toBe(2)
        c.onRowDragLeave(FIXTURE_FILES[0])
        expect(c.dropHoverId()).toBe(2)
        c.onRowDragLeave(FIXTURE_FILES[1])
        expect(c.dropHoverId()).toBeNull()
      })

      it('ignores drag-over on a target the drag service rejects', () => {
        const res = mount(p.ctor as new () => unknown, (deps) => {
          seed(deps)
          deps.dragCanDropOnFile = false
        })
        const c = res.component as BrowserApi
        c.ngOnInit()
        let prevented = 0
        c.onRowDragOver({ preventDefault: () => prevented++ } as unknown as DragEvent, FIXTURE_FILES[1])
        expect(prevented).toBe(0)
        expect(c.dropHoverId()).toBeNull()
      })

      it('moves the dragged payload into the dropped folder', () => {
        const res = mount(p.ctor as new () => unknown, (deps) => {
          seed(deps, ['sub'])
          deps.dragPayload = { files: [FIXTURE_FILES[0]], sourceDir: dirPath(['sub']), draggedIds: new Set([1]) }
        })
        const c = res.component as BrowserApi
        c.ngOnInit()
        c.onRowDrop({ preventDefault: () => undefined } as unknown as DragEvent, FIXTURE_FILES[1])
        const call = res.deps.log.only('files.copyMove')
        expect((call.args[0] as { path: string }[])[0].path).toBe(filePath('alpha.txt', ['sub']))
        expect(call.args[1]).toBe(`${dirPath(['sub'])}/beta`)
        expect(call.args[2]).toBe(FILE_OPERATION.MOVE)
        expect(res.deps.log.only('toast.success').args).toEqual(['v2_moving_one_progress', { name: 'alpha.txt' }])
        expect(res.deps.log.count('drag.end')).toBe(1)
      })

      it('routes a breadcrumb drop through the registered handler', () => {
        const { deps } = start(['sub'])
        expect(deps.dropHandler).toBeTypeOf('function')
        deps.dropHandler!(dirPath([]), [FIXTURE_FILES[0], FIXTURE_FILES[2]])
        expect(deps.log.only('files.copyMove').args[1]).toBe(dirPath([]))
        expect(deps.log.only('toast.success').args).toEqual(['v2_moving_n_progress', { nb: 2 }])
      })

      it('ends the drag without moving anything when the target is rejected', () => {
        const res = mount(p.ctor as new () => unknown, (deps) => {
          seed(deps)
          deps.dragCanDropOnFile = false
        })
        const c = res.component as BrowserApi
        c.ngOnInit()
        c.onRowDrop({ preventDefault: () => undefined } as unknown as DragEvent, FIXTURE_FILES[1])
        expect(res.deps.log.count('files.copyMove')).toBe(0)
        expect(res.deps.log.count('drag.end')).toBe(1)
      })
    })

    // -----------------------------------------------------------------------
    // J. Download / archive
    // -----------------------------------------------------------------------
    describe('download', () => {
      it('opens the files-operation URL in the same tab, never for a folder', () => {
        const { win, restore } = installWindowStub()
        try {
          const { c } = start(['sub'])
          c.downloadFile(FIXTURE_FILES[1])
          expect(win.opened).toEqual([])
          c.downloadFile(FIXTURE_FILES[0])
          expect(win.opened).toEqual([{ url: `${OPERATION}/${filePath('alpha.txt', ['sub'])}`, target: '_self', features: undefined }])
        } finally {
          restore()
        }
      })

      it('downloads a single selected file directly', () => {
        const { win, restore } = installWindowStub()
        try {
          const { c, deps } = start()
          c.toggleSelection(FIXTURE_FILES[0])
          c.bulkDownload()
          expect(win.opened.length).toBe(1)
          expect(deps.log.count('compressDialog.open')).toBe(0)
        } finally {
          restore()
        }
      })

      it('compresses a multi-row selection, seeding the archive name from the folder', async () => {
        const { c, deps } = start(['sub'])
        c.toggleSelection(FIXTURE_FILES[0])
        c.toggleSelection(FIXTURE_FILES[2])
        deps.compressResults.results.push({ name: 'bundle', compressInDirectory: false, compression: 0, extension: 'zip' })
        c.bulkDownload()
        await Promise.resolve()
        await Promise.resolve()
        expect(deps.log.only('compressDialog.open').args[0]).toMatchObject({ initialValue: 'sub', fileCount: 2 })
        // currentRoute must be assigned BEFORE the task is queued.
        expect(deps.currentRouteWrites).toEqual([dirPath(['sub'])])
        expect(deps.log.sequence().indexOf('files.currentRoute=')).toBeLessThan(deps.log.sequence().indexOf('files.compress'))
        expect(deps.log.only('files.compress').args[0]).toEqual({
          name: 'bundle',
          compressInDirectory: false,
          compression: 0,
          extension: 'zip',
          files: [
            { name: 'alpha.txt', rootAlias: p.compressRootAlias, path: filePath('alpha.txt', ['sub']) },
            { name: 'gamma.pdf', rootAlias: p.compressRootAlias, path: filePath('gamma.pdf', ['sub']) }
          ]
        })
        expect(deps.log.only('toast.success').args).toEqual(['v2_archiving_n_progress', { nb: 2 }])
        expect(c.hasSelection()).toBe(false)
      })

      it('seeds the archive name from the repository when at its root', async () => {
        const { c, deps } = start()
        c.toggleSelection(FIXTURE_FILES[0])
        c.toggleSelection(FIXTURE_FILES[2])
        c.bulkDownload()
        await Promise.resolve()
        expect(deps.log.only('compressDialog.open').args[0]).toMatchObject({ initialValue: p.rootArchiveName })
      })

      it('compresses a single selected folder rather than downloading it', async () => {
        const { c, deps } = start()
        c.toggleSelection(FIXTURE_FILES[1])
        c.bulkDownload()
        await Promise.resolve()
        expect(deps.log.count('compressDialog.open')).toBe(1)
      })

      it('does nothing when the compress dialog is dismissed', async () => {
        const { c, deps } = start()
        c.toggleSelection(FIXTURE_FILES[0])
        c.toggleSelection(FIXTURE_FILES[2])
        c.bulkDownload()
        await Promise.resolve()
        await Promise.resolve()
        expect(deps.log.count('files.compress')).toBe(0)
      })

      it('does nothing with an empty selection', () => {
        const { c, deps } = start()
        c.bulkDownload()
        expect(deps.log.count('compressDialog.open')).toBe(0)
      })

      it('rejects a blank archive name in the dialog validator', async () => {
        const { c, deps } = start()
        c.toggleSelection(FIXTURE_FILES[0])
        c.toggleSelection(FIXTURE_FILES[2])
        c.bulkDownload()
        await Promise.resolve()
        const validate = (deps.log.only('compressDialog.open').args[0] as Record<string, unknown>)['validate'] as (v: string) => string | null
        expect(validate('  ')).toBe('Name is required')
        expect(validate('ok')).toBeNull()
      })

      it('decompresses into the current folder after setting the task route', () => {
        const { c, deps } = start(['sub'])
        c.decompressEntry(FIXTURE_FILES[3])
        expect(deps.currentRouteWrites).toEqual([dirPath(['sub'])])
        expect((deps.log.only('files.decompress').args[0] as { path: string }).path).toBe(filePath('delta.zip', ['sub']))
        expect(deps.log.only('toast.success').args).toEqual(['v2_decompressing_progress', { name: 'delta.zip' }])
      })
    })

    // -----------------------------------------------------------------------
    // K. Folder size + favorites
    // -----------------------------------------------------------------------
    describe('folder size and favorites', () => {
      it('computes a folder size against the absolute repository path', () => {
        const { c, deps } = start(['sub'])
        c.calculateFolderSize(FIXTURE_FILES[1])
        expect(deps.log.only('folderSize.compute').args[1]).toBe(filePath('beta', ['sub']))
      })

      it('exposes the folder-size state for a row', () => {
        const { c } = start()
        expect(c.folderSizeState(2)).toEqual({ status: 'idle', id: 2 })
      })

      it('stars an unstarred row and unstars a starred one', () => {
        const { c, deps } = start(['sub'])
        c.toggleFavorite(FIXTURE_FILES[0])
        expect(deps.log.only('favorites.toggle').args).toEqual([filePath('alpha.txt', ['sub']), 1, true])
        deps.favoriteIds.add(1)
        deps.log.clear()
        c.toggleFavorite(FIXTURE_FILES[0])
        expect(deps.log.only('favorites.toggle').args).toEqual([filePath('alpha.txt', ['sub']), 1, false])
      })
    })

    // -----------------------------------------------------------------------
    // L. Links and shares — the per-screen DTO seam
    // -----------------------------------------------------------------------
    describe('links and shares', () => {
      it('opens the link dialog with a path relative to the repository root', async () => {
        const { c, deps } = start(['sub'])
        await c.getLink(FIXTURE_FILES[0])
        expect(deps.log.only('linkDialog.open').args[0]).toEqual({
          file: { id: 1, name: 'alpha.txt', isDir: false, mime: 'text/plain', space: p.dialogSpace },
          relativePath: 'sub/alpha.txt',
          ownerId: p.dialogOwnerId
        })
      })

      it('opens the share dialog with the same single-file shape', async () => {
        const { c, deps } = start(['sub'])
        await c.shareEntry(FIXTURE_FILES[0])
        expect(deps.log.only('shareDialog.open').args[0]).toEqual({
          file: { id: 1, name: 'alpha.txt', isDir: false, mime: 'text/plain', space: p.dialogSpace },
          relativePath: 'sub/alpha.txt',
          ownerId: p.dialogOwnerId
        })
      })

      it('refuses a bulk share when anything in the selection is already shared', async () => {
        const shared = file({ id: 9, name: 'shared.txt', shares: [{ id: 1 }] } as never)
        const { c, deps } = start([], [...FIXTURE_FILES, shared])
        c.toggleSelection(FIXTURE_FILES[0])
        c.toggleSelection(shared)
        await c.bulkShare()
        expect(deps.log.only('toast.error').args[0]).toBe('Some selected files are already shared — share them individually.')
        expect(deps.log.count('shareDialog.open')).toBe(0)
      })

      it('routes a single-row bulk share through the single-file path', async () => {
        const { c, deps } = start()
        c.toggleSelection(FIXTURE_FILES[0])
        await c.bulkShare()
        expect(deps.log.only('shareDialog.open').args[0]).toHaveProperty('file')
      })

      it('opens a multi-file share, then clears the selection and reloads', async () => {
        const { c, deps } = start(['sub'])
        c.toggleSelection(FIXTURE_FILES[0])
        c.toggleSelection(FIXTURE_FILES[2])
        await c.bulkShare()
        expect(deps.log.only('shareDialog.open').args[0]).toEqual({
          files: [
            {
              file: { id: 1, name: 'alpha.txt', isDir: false, mime: 'text/plain', space: p.dialogSpace },
              relativePath: 'sub/alpha.txt',
              ownerId: p.dialogOwnerId
            },
            {
              file: { id: 3, name: 'gamma.pdf', isDir: false, mime: 'application/pdf', space: p.dialogSpace },
              relativePath: 'sub/gamma.pdf',
              ownerId: p.dialogOwnerId
            }
          ]
        })
        expect(c.hasSelection()).toBe(false)
        expect(deps.log.count('http.get')).toBe(2)
      })

      it('does nothing with an empty selection', async () => {
        const { c, deps } = start()
        await c.bulkShare()
        expect(deps.log.count('shareDialog.open')).toBe(0)
      })
    })

    // -----------------------------------------------------------------------
    // L2. Locks — the unlock-only affordance behind the locked-row badge.
    //
    // Parity target: classic's `FilesLockDialogComponent`, reached from
    // `openLockDialog` on the badge (spaces-browser.component.html:252 / :427).
    // There is deliberately no "lock this file" gesture to pin — classic has
    // none, so neither does this.
    // -----------------------------------------------------------------------
    describe('locks', () => {
      const owner = (login: string) => ({ id: 1, login, email: `${login}@example.test`, fullName: `${login} Name` })

      const lockedRow = (lockLogin: string, rootOwnerLogin?: string) =>
        file({
          id: 42,
          name: 'locked.txt',
          lock: { owner: owner(lockLogin), app: 'sync-in', info: 'edit', isExclusive: true },
          ...(rootOwnerLogin ? { root: { id: 1, alias: 'r', permissions: 'v:m', owner: owner(rootOwnerLogin) } } : {})
        } as never)

      it('does nothing on a row that is not locked', async () => {
        const { c, deps } = start()
        await c.openLockDialog(FIXTURE_FILES[0])
        expect(deps.log.count('lockDialog.open')).toBe(0)
      })

      it('opens the unlock dialog with the row name, the lock, and the file-owner verdict', async () => {
        const row = lockedRow('someone-else')
        const { c, deps } = start([], [row])
        await c.openLockDialog(row)
        expect(deps.log.only('lockDialog.open').args[0]).toEqual({
          fileName: 'locked.txt',
          lock: row.lock,
          // Personal short-circuits to true; a space has to find the login on
          // the row's root, and this row's root owner is someone else.
          isFileOwner: p.filesAreOwnedByUser
        })
      })

      it('treats the user as the file owner when the row root names them', async () => {
        const row = lockedRow('someone-else', p.userLogin)
        const { c, deps } = start([], [row])
        await c.openLockDialog(row)
        expect(deps.log.only('lockDialog.open').args[0]).toMatchObject({ isFileOwner: true })
      })

      it('unlocks through the classic endpoint, passing isFileOwner as forceAsFileOwner', async () => {
        const row = lockedRow('someone-else')
        const { c, deps } = start(['sub'], [row])
        deps.lockResults.results.push('unlock')
        await c.openLockDialog(row)
        const call = deps.log.only('files.unlock')
        expect((call.args[0] as { path: string }).path).toBe(filePath('locked.txt', ['sub']))
        expect(call.args[1]).toBe(p.filesAreOwnedByUser)
        expect(deps.log.count('files.unlockRequest')).toBe(0)
      })

      it('toasts and reloads after an unlock, in that order', async () => {
        const row = lockedRow(p.userLogin)
        const { c, deps } = start([], [row])
        deps.lockResults.results.push('unlock')
        deps.log.clear()
        await c.openLockDialog(row)
        // Sliced: the reload's own follow-on calls differ per screen (space-files
        // resolves its space name from the listing) and are pinned elsewhere.
        expect(deps.log.sequence().slice(0, 4)).toEqual(['lockDialog.open', 'files.unlock', 'toast.success', 'http.get'])
        expect(deps.log.only('toast.success').args).toEqual(['v2_file_unlocked', { name: 'locked.txt' }])
      })

      it('drops the lock off the row optimistically, ahead of the reload', () => {
        const row = lockedRow('someone-else')
        const { c } = start([], [row])
        expect(c.files()[0].lock).toBeTruthy()
        c.stripLock(42)
        expect(c.files()[0].lock).toBeUndefined()
      })

      it('lets the reload put a lock back — the browse response is the authority', async () => {
        const row = lockedRow('someone-else')
        const { c, deps } = start([], [row])
        deps.lockResults.results.push('unlock')
        await c.openLockDialog(row)
        expect(c.files()[0].lock).toBeTruthy()
      })

      it('sends an unlock request instead when that is the choice, naming the holder', async () => {
        const row = lockedRow('someone-else')
        const { c, deps } = start(['sub'], [row])
        deps.lockResults.results.push('request')
        await c.openLockDialog(row)
        expect((deps.log.only('files.unlockRequest').args[0] as { path: string }).path).toBe(filePath('locked.txt', ['sub']))
        expect(deps.log.count('files.unlock')).toBe(0)
        expect(deps.log.only('toast.success').args).toEqual(['v2_unlock_request_sent', { owner: 'someone-else Name' }])
      })

      it('does nothing when the dialog is dismissed', async () => {
        const row = lockedRow('someone-else')
        const { c, deps } = start([], [row])
        await c.openLockDialog(row)
        expect(deps.log.count('files.unlock')).toBe(0)
        expect(deps.log.count('files.unlockRequest')).toBe(0)
      })

      // A 409 lock conflict answers with a bare FileLockProps body and no
      // `message` at all (FileError / LockConflict extend Error, not
      // HttpException), so a naive `e.error.message` would toast "undefined".
      it('falls back to its own message when the error body carries none', async () => {
        const row = lockedRow('someone-else')
        const { c, deps } = start([], [row])
        deps.lockResults.results.push('unlock')
        deps.unlockError = { status: 409, body: { owner: owner('someone-else'), app: 'sync-in', isExclusive: true } }
        await c.openLockDialog(row)
        expect(deps.log.only('toast.error').args[0]).toBe('Unlock failed')
      })

      it('prefers the server message when there is one', async () => {
        const row = lockedRow('someone-else')
        const { c, deps } = start([], [row])
        deps.lockResults.results.push('unlock')
        deps.unlockError = { status: 403, body: { message: 'Not allowed' } }
        await c.openLockDialog(row)
        expect(deps.log.only('toast.error').args[0]).toBe('Not allowed')
      })

      it('reports a failed unlock request too', async () => {
        const row = lockedRow('someone-else')
        const { c, deps } = start([], [row])
        deps.lockResults.results.push('request')
        deps.unlockRequestError = { status: 500, body: null }
        await c.openLockDialog(row)
        expect(deps.log.only('toast.error').args[0]).toBe('Unlock request failed')
      })

      // Classic's FileLockFormatPipe, verbatim: name (email) - info app.
      it('formats the badge tooltip the way classic formats it', () => {
        const row = lockedRow('someone-else')
        const { c } = start([], [row])
        expect(c.lockLabel(row)).toBe('someone-else Name (someone-else@example.test) - edit sync-in')
        expect(c.lockLabel(FIXTURE_FILES[0])).toBe('')
      })
    })

    // -----------------------------------------------------------------------
    // M. Creation
    // -----------------------------------------------------------------------
    describe('creation', () => {
      it('creates a folder in the current directory', async () => {
        const { c, deps } = start(['sub'])
        deps.promptResults.results.push('  New folder  ')
        await c.newFolder()
        expect(deps.log.only('promptDialog.open').args[0]).toMatchObject({ title: 'New folder', placeholder: 'Folder name', submitLabel: 'Create' })
        expect(deps.log.only('files.make').args).toEqual(['directory', 'New folder', dirPath(['sub']), true])
        expect(deps.log.only('toast.success').args).toEqual(['v2_folder_created', { name: 'New folder' }])
        expect(deps.log.count('http.get')).toBe(2)
      })

      it('reports a folder-creation failure with the server message', async () => {
        const { c, deps } = start()
        deps.promptResults.results.push('x')
        deps.makeError = { status: 409, message: 'exists' }
        await c.newFolder()
        expect(deps.log.only('toast.error').args[0]).toBe('exists')
      })

      it('skips creation when the prompt is cancelled', async () => {
        const { c, deps } = start()
        await c.newFolder()
        expect(deps.log.count('files.make')).toBe(0)
      })

      it('creates a text file pre-named Untitled.txt', async () => {
        const { c, deps } = start(['sub'])
        deps.promptResults.results.push('notes.txt')
        await c.newTextFile()
        expect(deps.log.only('promptDialog.open').args[0]).toMatchObject({
          title: 'New text file',
          initialValue: 'Untitled.txt',
          selectionRange: 'stem'
        })
        expect(deps.log.only('files.make').args).toEqual(['file', 'notes.txt', dirPath(['sub']), true])
        expect(deps.log.only('toast.success').args).toEqual(['v2_file_created', { name: 'notes.txt' }])
      })

      it('creates a markdown file and opens it in the editor', async () => {
        const { c, deps } = start(['sub'])
        deps.promptResults.results.push('doc.md')
        await c.newMarkdownFile()
        expect(deps.log.only('promptDialog.open').args[0]).toMatchObject({ title: 'New markdown file', initialValue: 'Untitled.md' })
        expect(deps.log.only('files.make').args).toEqual(['file', 'doc.md', dirPath(['sub']), true])
        expect(deps.log.only('router.navigate').args[1]).toEqual({ queryParams: { path: `${dirPath(['sub'])}/doc.md` } })
      })

      it('auto-names an office file and only opens it when an office editor is on', () => {
        const withoutEditor = start(['sub'])
        withoutEditor.c.dispatchNewEntry('new-docx')
        expect(withoutEditor.deps.log.only('files.make').args).toEqual(['file', 'Untitled.docx', dirPath(['sub']), true])
        expect(withoutEditor.deps.log.only('toast.success').args).toEqual(['v2_item_created', { name: 'Untitled.docx' }])
        expect(withoutEditor.deps.log.count('router.navigate')).toBe(0)

        const withEditor = mount(p.ctor as new () => unknown, (deps) => {
          seed(deps, ['sub'])
          deps.serverConfig.set({ files: { editors: { onlyoffice: true, eurooffice: false, collabora: false } } })
        })
        const c2 = withEditor.component as BrowserApi
        c2.ngOnInit()
        c2.dispatchNewEntry('new-xlsx')
        expect(withEditor.deps.log.only('router.navigate').args[1]).toEqual({ queryParams: { path: `${dirPath(['sub'])}/Untitled.xlsx` } })
      })

      it('side-steps a name collision when auto-naming', () => {
        const taken = [file({ id: 20, name: 'Untitled.pptx' }), file({ id: 21, name: 'untitled (2).PPTX' })]
        const { c, deps } = start([], taken)
        c.dispatchNewEntry('new-pptx')
        expect(deps.log.only('files.make').args[1]).toBe('Untitled (3).pptx')
      })

      it('creates a diagram via the diagrams endpoint and opens the returned path', () => {
        const res = mount(p.ctor as new () => unknown, (deps) => {
          seed(deps, ['sub'])
          deps.httpPostResponses.set('/api/diagrams/new', { path: 'files/whatever/Untitled diagram.drawio' })
        })
        const c = res.component as BrowserApi
        c.ngOnInit()
        c.dispatchNewEntry('new-diagram')
        const post = res.deps.log.only('http.post')
        expect(post.args[0]).toBe('/api/diagrams/new')
        expect(post.args[1]).toEqual({ dirPath: dirPath(['sub']), name: 'Untitled diagram.drawio' })
        expect(res.deps.log.only('toast.success').args).toEqual(['v2_item_created', { name: 'Untitled diagram.drawio' }])
        expect(res.deps.log.only('router.navigate').args[1]).toEqual({ queryParams: { path: 'files/whatever/Untitled diagram.drawio' } })
      })

      it('reports a diagram failure with the server message', () => {
        const res = mount(p.ctor as new () => unknown, (deps) => {
          seed(deps)
          deps.httpPostError = 500
        })
        const c = res.component as BrowserApi
        c.ngOnInit()
        c.dispatchNewEntry('new-diagram')
        expect(res.deps.log.only('toast.error').args[0]).toBe('post failed')
      })

      it('validates a new entry name against the current listing', async () => {
        const { c, deps } = start()
        await c.newFolder()
        const validate = (deps.log.only('promptDialog.open').args[0] as Record<string, unknown>)['validate'] as (v: string) => string | null
        expect(validate('')).toBe('Name is required')
        expect(validate('a/b')).toBe('Name cannot contain slashes')
        expect(validate('..')).toBe('Invalid name')
        expect(validate('ALPHA.TXT')).toBe('A file or folder with this name already exists')
        expect(validate('fresh')).toBeNull()
      })

      it('downloads from a URL after confirming the save name', async () => {
        const { c, deps } = start(['sub'])
        deps.promptResults.results.push('https://example.com/a/thing.bin', 'thing.bin')
        await c.downloadFromUrl()
        const prompts = deps.log.of('promptDialog.open')
        expect(prompts.length).toBe(2)
        expect(prompts[0].args[0]).toMatchObject({ title: 'Download from URL', submitLabel: 'Next' })
        expect(prompts[1].args[0]).toMatchObject({ title: 'Save as', initialValue: 'thing.bin', submitLabel: 'Download' })
        expect(deps.currentRouteWrites).toEqual([dirPath(['sub'])])
        expect(deps.log.only('files.downloadFromUrl').args).toEqual(['https://example.com/a/thing.bin', 'thing.bin'])
        expect(deps.log.only('toast.success').args).toEqual(['v2_downloading_one', { name: 'thing.bin' }])
      })

      it('rejects a non-http URL in the first prompt', async () => {
        const { c, deps } = start()
        await c.downloadFromUrl()
        const validate = (deps.log.only('promptDialog.open').args[0] as Record<string, unknown>)['validate'] as (v: string) => string | null
        expect(validate('nope')).toBe('Malformed URL')
        expect(validate('https://example.com/x')).toBeNull()
      })

      it('abandons the URL download if the save name is cancelled', async () => {
        const { c, deps } = start()
        deps.promptResults.results.push('https://example.com/a/thing.bin', null)
        await c.downloadFromUrl()
        expect(deps.log.count('files.downloadFromUrl')).toBe(0)
      })
    })

    // -----------------------------------------------------------------------
    // N. Upload
    // -----------------------------------------------------------------------
    describe('upload', () => {
      it('sets the task route before handing a drop to the upload service', () => {
        const { c, deps } = start(['sub'])
        const ev = { dataTransfer: {} } as DragEvent
        c.onDropFiles(ev)
        expect(deps.currentRouteWrites).toEqual([dirPath(['sub'])])
        expect(deps.log.only('upload.onDropFiles').args).toEqual([ev, []])
      })

      it('uploads picked files without overwrite and reloads afterwards', async () => {
        const { c, deps } = start(['sub'])
        c.onFilePicked({ target: { files: ['a', 'b'] } } as unknown as Event)
        expect(deps.currentRouteWrites).toEqual([dirPath(['sub'])])
        expect(deps.log.only('upload.addFiles').args).toEqual([['a', 'b'], false])
        await Promise.resolve()
        await Promise.resolve()
        expect(deps.log.count('http.get')).toBe(2)
      })

      it('ignores an empty file pick', () => {
        const { c, deps } = start()
        c.onFilePicked({ target: { files: [] } } as unknown as Event)
        expect(deps.log.count('upload.addFiles')).toBe(0)
      })

      it('clears and clicks the hidden file input', () => {
        const { c } = start()
        const input = {
          value: 'stale',
          clicked: 0,
          click() {
            this.clicked++
          }
        }
        c.fileInput = { nativeElement: input }
        c.triggerFilePicker()
        expect(input.value).toBe('')
        expect(input.clicked).toBe(1)
      })
    })

    // -----------------------------------------------------------------------
    // O. Menus
    // -----------------------------------------------------------------------
    describe('menus', () => {
      it('opens and closes the row context menu at the pointer', () => {
        const { c } = start()
        let stopped = 0
        let prevented = 0
        c.openRowMenu(
          { clientX: 11, clientY: 22, stopPropagation: () => stopped++, preventDefault: () => prevented++ } as unknown as MouseEvent,
          FIXTURE_FILES[0]
        )
        expect(c.menu()).toEqual({ file: FIXTURE_FILES[0], x: 11, y: 22 })
        expect([stopped, prevented]).toEqual([1, 1])
        c.closeMenu()
        expect(c.menu()).toBeNull()
      })

      it('lists no menu items when nothing is open', () => {
        const { c } = start()
        expect(c.menuItems()).toEqual([])
      })

      it('offers the file menu in a fixed order, without decompress for a plain file', () => {
        const { c } = start()
        c.openRowMenu(
          { clientX: 0, clientY: 0, stopPropagation: () => undefined, preventDefault: () => undefined } as unknown as MouseEvent,
          FIXTURE_FILES[0]
        )
        const items = c.menuItems() as { id: string; disabled?: boolean; label: string }[]
        expect(items.map((i) => i.id)).toEqual([
          'open',
          'download',
          'rename',
          'size',
          'copy',
          'move',
          'get-link',
          'share',
          'favorite',
          'comments',
          'delete'
        ])
        expect(items.find((i) => i.id === 'download')!.disabled).toBe(false)
        expect(items.find((i) => i.id === 'size')!.disabled).toBe(true)
        expect(items.find((i) => i.id === 'comments')!.disabled).toBe(false)
      })

      it('gates download/size/comments on whether the row is a folder', () => {
        const { c } = start()
        c.openRowMenu(
          { clientX: 0, clientY: 0, stopPropagation: () => undefined, preventDefault: () => undefined } as unknown as MouseEvent,
          FIXTURE_FILES[1]
        )
        const items = c.menuItems() as { id: string; disabled?: boolean; disabledReason?: string }[]
        expect(items.find((i) => i.id === 'download')).toMatchObject({ disabled: true, disabledReason: 'Coming soon' })
        expect(items.find((i) => i.id === 'size')!.disabled).toBe(false)
        expect(items.find((i) => i.id === 'comments')!.disabled).toBe(true)
      })

      it('offers decompress only for an archive file', () => {
        const { c } = start()
        const open = (f: FileProps) =>
          c.openRowMenu({ clientX: 0, clientY: 0, stopPropagation: () => undefined, preventDefault: () => undefined } as unknown as MouseEvent, f)
        open(FIXTURE_FILES[3])
        expect((c.menuItems() as { id: string }[])[2].id).toBe('decompress')
        open(FIXTURE_FILES[2])
        expect((c.menuItems() as { id: string }[]).some((i) => i.id === 'decompress')).toBe(false)
      })

      it('flips the favorite label with the current star state', () => {
        const { c, deps } = start()
        const open = () =>
          c.openRowMenu(
            { clientX: 0, clientY: 0, stopPropagation: () => undefined, preventDefault: () => undefined } as unknown as MouseEvent,
            FIXTURE_FILES[0]
          )
        open()
        expect((c.menuItems() as { id: string; label: string }[]).find((i) => i.id === 'favorite')!.label).toBe('Add to favorites')
        deps.favoriteIds.add(1)
        open()
        expect((c.menuItems() as { id: string; label: string }[]).find((i) => i.id === 'favorite')!.label).toBe('Remove from favorites')
      })

      it('anchors the "+ New" dropdown under its button', () => {
        const { c } = start()
        c.onNewMenuClick({ getBoundingClientRect: () => ({ left: 40, bottom: 60 }) } as unknown as HTMLElement)
        expect(c.newMenuAnchor()).toEqual({ x: 40, y: 64 })
        expect(c.newMenuOpen()).toBe(true)
      })

      it('closes the "+ New" dropdown when an item is chosen', async () => {
        const { c } = start()
        c.newMenuOpen.set(true)
        const items = c.newMenuItems() as { id: string; action?: () => void }[]
        const newFolder = items.find((i) => i.id === 'new-folder')!
        newFolder.action!()
        expect(c.newMenuOpen()).toBe(false)
        await Promise.resolve()
      })

      it('the mobile action sheet mirrors the create menu and adds Upload', () => {
        const { c } = start()
        const ids = (c.fabSheetItems() as { id: string }[]).map((i) => i.id)
        expect(ids.at(-1)).toBe('upload')
        expect(ids.at(-2)).toBe('sep-fab')
      })

      it('dispatches an action-sheet pick to the same handler as the dropdown', () => {
        const { c, deps } = start(['sub'])
        c.onFabSheetSelect('new-docx')
        expect(deps.log.only('files.make').args[1]).toBe('Untitled.docx')
      })

      it('routes the action sheet Upload entry to the file picker', () => {
        const { c } = start()
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
      })

      it(`${p.fabSheetClosesOnSelect ? 'closes' : 'leaves open'} the action sheet after a pick`, () => {
        const { c } = start()
        c.fabSheetOpen.set(true)
        c.onFabSheetSelect('new-docx')
        expect(c.fabSheetOpen()).toBe(!p.fabSheetClosesOnSelect)
      })
    })
  })
}
