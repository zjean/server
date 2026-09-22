// How the file screen RESOLVES a path to a row.
//
// `loadFile` browses the parent folder and picks its file out of the listing. Which
// field it picks on is a wire contract, not a detail: the last segment of a
// repository path is whatever ADDRESSES the row on the server, and for a share or a
// space root that is the alias while `name` is the human label
// (`files/models/file.model.ts:93` — `this.root?.alias || this.name`).
//
// #429 got this wrong from both ends at once: the Shared screen built
// `shares/<share name>`, and this screen matched the listing on `name`. The two
// mistakes cancelled out far enough to render a metadata row, and then every content
// URL 404'd, because the backend resolves `shares/<segment>` through `shares.alias`.
// Fixing one half alone breaks the other, so both are pinned here.
//
// Plain Injector, no TestBed — see screens/files/testing/file-browser-harness.ts.

import type { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { describe, expect, it } from 'vitest'
import type { HarnessDeps } from '../files/testing/file-browser-harness'
import { mount } from '../files/testing/file-browser-harness'
import { FileDetailComponent } from './file-detail.component'

const BROWSE = '/api/app/spaces/browse'

interface FileDetailApi {
  ngOnInit(): void
  file: () => FileProps | null
  currentPath: () => string
  errorMessage: () => string | null
  previewUrl: () => string
  canShare: () => boolean
}

function start(path: string, configure?: (deps: HarnessDeps) => void): { c: FileDetailApi; deps: HarnessDeps } {
  const res = mount(FileDetailComponent, (deps) => {
    deps.routeQueryParams.next({ path })
    configure?.(deps)
  })
  const c = res.component as unknown as FileDetailApi
  c.ngOnInit()
  res.flush()
  return { c, deps: res.deps }
}

// One entry of the shares-repository root listing: the incoming share "Sprint
// notes.md", whose alias is the slug the wire knows it by.
const SHARED_FILE = {
  id: 42,
  name: 'Sprint notes.md',
  isDir: false,
  mime: 'text-markdown',
  mtime: 1_700_000_000_000,
  root: { id: 8, alias: 'sprint-notes-md', owner: { login: 'ann', fullName: 'Ann Jones' } }
}

describe('v2 file screen — resolving a path to a row', () => {
  it('finds a shared FILE by its share alias, which is how the path addresses it', () => {
    const { c, deps } = start('shares/sprint-notes-md', (deps) => {
      deps.httpGetResponses.set(`${BROWSE}/shares`, { files: [SHARED_FILE] })
    })
    expect(deps.log.only('http.get').args[0]).toBe(`${BROWSE}/shares`)
    expect(c.errorMessage()).toBeNull()
    expect(c.file()?.name).toBe('Sprint notes.md')
    // The content URL is built from the path as given, so it stays the alias form —
    // the form the backend actually resolves.
    expect(c.previewUrl()).toBe('/api/app/spaces/operation/shares/sprint-notes-md')
  })

  it('still finds an ordinary file by name, where there is no root and the two spellings coincide', () => {
    const { c } = start('files/personal/notes.md', (deps) => {
      deps.httpGetResponses.set(`${BROWSE}/files/personal`, {
        files: [
          { id: 1, name: 'other.md', isDir: false, mime: 'text-markdown', mtime: 1 },
          { id: 2, name: 'notes.md', isDir: false, mime: 'text-markdown', mtime: 1 }
        ]
      })
    })
    expect(c.file()?.id).toBe(2)
  })

  it('reports a miss rather than rendering the wrong row when the segment matches nothing', () => {
    const { c } = start('shares/gone', (deps) => {
      deps.httpGetResponses.set(`${BROWSE}/shares`, { files: [SHARED_FILE] })
    })
    expect(c.errorMessage()).toBe('File not found in parent folder.')
    expect(c.file()).toBeNull()
  })

  it('reads the REPOSITORY from segment 0, so a share alias in segment 1 is not mistaken for a space', () => {
    const { c } = start('shares/sprint-notes-md', (deps) => {
      deps.httpGetResponses.set(`${BROWSE}/shares`, { files: [SHARED_FILE] })
    })
    // Re-sharing from inside the shares repository is not offered; before this the
    // test read segment 1 — the share alias — and answered true for every such file.
    expect(c.canShare()).toBe(false)
  })
})
