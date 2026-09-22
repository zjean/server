// Behavioural pin for the v2 trash bin's "Empty trash".
//
// Upstream 2.5.2 made emptying a SERVER-SIDE task (`588c8bbd`); v2 used to enumerate
// the loaded rows and delete them one by one. These cases pin the difference, because
// nothing else can: the two operations reach the same end state on a small bin, so a
// regression to the client-side loop would look correct in a browser.
//
// Reuses the file-browser harness (plain Injector, no TestBed) — see
// `files/testing/file-browser-harness.ts` for why there is no DOM here.

import { beforeEach, describe, expect, it } from 'vitest'
import { file, mount, urlSegments } from '../files/testing/file-browser-harness'
import type { HarnessDeps, MountResult } from '../files/testing/file-browser-harness'
import { TrashBinComponent } from './trash-bin.component'

/** The protected surface these cases drive. */
interface TrashBinApi {
  ngOnInit(): void
  confirmAndEmptyTrash(): Promise<void>
  files: () => unknown[]
  emptying: () => boolean
  binDisplayName: () => string
}

const BIN_FILES = [file({ id: 1, name: 'alpha.txt' }), file({ id: 2, name: 'beta', isDir: true, mime: 'directory' })]

function browseUrl(alias: string, ...segs: string[]): string {
  return ['/api/app/spaces/browse/trash', alias, ...segs].join('/')
}

function start(options: {
  alias?: string
  segs?: string[]
  space?: { alias: string; name: string }
  files?: unknown[]
  confirm?: boolean
  emptyTrashError?: { status: number; message: string }
}): MountResult<TrashBinComponent> & { c: TrashBinApi; deps: HarnessDeps } {
  const alias = options.alias ?? 'personal'
  const segs = options.segs ?? []
  const res = mount(TrashBinComponent, (deps) => {
    deps.routeParams.next({ alias })
    deps.routeUrl.next(urlSegments(...segs))
    deps.httpGetResponses.set(browseUrl(alias, ...segs), {
      space: options.space ?? { alias, name: alias },
      files: options.files ?? BIN_FILES
    })
    deps.confirmResults = { results: [options.confirm ?? true], fallback: options.confirm ?? true }
    deps.emptyTrashError = options.emptyTrashError ?? null
  })
  const c = res.component as unknown as TrashBinApi
  c.ngOnInit()
  res.flush()
  return { ...res, c, deps: res.deps }
}

describe('v2 trash bin — empty trash', () => {
  it('asks the SERVER to empty the bin instead of deleting the rows it loaded', async () => {
    const { c, deps } = start({})
    await c.confirmAndEmptyTrash()

    expect(deps.log.only('files.emptyTrash').args[0]).toBe('personal')
    // The old implementation called this once per loaded row. Nothing may call it now:
    // deleting `files()` is a different operation that only happens to look the same.
    expect(deps.log.count('files.delete')).toBe(0)
  })

  it('labels the personal bin with the translated title, not its alias', async () => {
    // The personal space is static server-side, so its browse response says `personal`
    // for BOTH alias and name — classic substitutes the title for exactly this case.
    const { c, deps } = start({ alias: 'personal', space: { alias: 'personal', name: 'personal' } })
    await c.confirmAndEmptyTrash()

    expect(deps.log.only('files.emptyTrash').args[1]).toBe('Personal space')
  })

  it("labels a shared space's bin with the space name from the browse response", async () => {
    const { c, deps } = start({ alias: 'team-x', space: { alias: 'team-x', name: 'Team X' } })
    await c.confirmAndEmptyTrash()

    expect(deps.log.only('files.emptyTrash').args).toEqual(['team-x', 'Team X'])
  })

  it('reports success only once the request has been accepted', async () => {
    const { c, deps } = start({})
    await c.confirmAndEmptyTrash()

    expect(deps.log.only('toast.success').args[0]).toBe('v2_emptying_trash_progress')
    expect(deps.log.count('toast.error')).toBe(0)
  })

  it('reports a failure instead of announcing progress that never started', async () => {
    const { c, deps } = start({ emptyTrashError: { status: 500, message: 'boom' } })
    await c.confirmAndEmptyTrash()

    expect(deps.log.count('toast.success')).toBe(0)
    expect(deps.log.only('toast.error').args[0]).toBe('Deletion failed')
    // The flag has to clear, or a transient server error would wedge the button.
    expect(c.emptying()).toBe(false)
  })

  it('does nothing when the confirmation is declined', async () => {
    const { c, deps } = start({ confirm: false })
    await c.confirmAndEmptyTrash()

    expect(deps.log.count('files.emptyTrash')).toBe(0)
    expect(deps.log.count('toast.success')).toBe(0)
  })

  it('does nothing on an already-empty bin', async () => {
    const { c, deps } = start({ files: [] })
    await c.confirmAndEmptyTrash()

    expect(deps.log.count('confirmDialog.open')).toBe(0)
    expect(deps.log.count('files.emptyTrash')).toBe(0)
  })

  it('refuses to empty the whole bin from inside one of its folders', async () => {
    // `emptyTrash` addresses the bin ROOT wherever the user is, so the scope guard
    // cannot live only on the button the template hides.
    const { c, deps } = start({ segs: ['beta'] })
    await c.confirmAndEmptyTrash()

    expect(deps.log.count('confirmDialog.open')).toBe(0)
    expect(deps.log.count('files.emptyTrash')).toBe(0)
  })
})

describe('v2 trash bin — refresh after the server-side task', () => {
  let res: ReturnType<typeof start>

  beforeEach(() => {
    res = start({})
    res.deps.log.clear()
  })

  it("reloads on the empty-trash task's completion event, which addresses the bin root", () => {
    // `FilesTasksService` derives the event from `task.path`/`task.name`, and the task
    // was created against `trash/<alias>` — so it reads `{ filePath: 'trash',
    // fileName: '<alias>' }`, never the 'trash/personal' route this screen sits on.
    res.deps.filesOnEvent.next({ filePath: 'trash', fileName: 'personal' })

    expect(res.deps.log.count('http.get')).toBe(1)
  })

  it('still reloads on a per-row delete, which addresses the folder', () => {
    res.deps.filesOnEvent.next({ filePath: 'trash/personal', fileName: 'alpha.txt' })

    expect(res.deps.log.count('http.get')).toBe(1)
  })

  it("ignores another bin's empty-trash event", () => {
    res.deps.filesOnEvent.next({ filePath: 'trash', fileName: 'some-other-space' })

    expect(res.deps.log.count('http.get')).toBe(0)
  })
})
