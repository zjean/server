// Pins the folder-readme edit session — design §5's correctness crux.
//
// Every rule here was previously reachable only through a browser, and §11 records
// three of them as untestable in this environment (they need a second user account
// or a space without the modify permission). The state machine itself needs
// neither: it is a plain object over signals, so the orderings that matter — the
// teardown that must happen even when the save fails, the guard that stops one
// edit becoming two uploads, the queued intent that must not follow the user into
// the next folder — are checked directly.

import { describe, expect, it, vi } from 'vitest'
import type { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { ReadmeEditSession, type ReadmeSaveOutcome } from './readme-edit-session'

function row(name = 'Readme.md'): FileProps {
  return { id: 1, name, isDir: false, mime: 'text-markdown', size: 120, ctime: 0, mtime: 0 } as FileProps
}

function target(dir: string, file = row()) {
  return { path: `${dir}/${file.name}`, file }
}

const DIR_A = 'files/personal/notes'
const DIR_B = 'files/personal/archive'

describe('ReadmeEditSession — opening and closing', () => {
  it('starts closed with no target', () => {
    const s = new ReadmeEditSession()
    expect(s.editing()).toBe(false)
    expect(s.target()).toBe(null)
  })

  it('freezes the target handed to open()', () => {
    const s = new ReadmeEditSession()
    const t = target(DIR_A)
    s.open(t)
    expect(s.editing()).toBe(true)
    expect(s.target()).toBe(t)
    // Nothing else can move it: the only writers are open() and close(). This is
    // the property that stops a mid-edit folder change from re-pointing the editor.
    s.noteDir(DIR_B)
    expect(s.target()).toBe(t)
  })

  it('clears the target on close so a later open re-captures', () => {
    const s = new ReadmeEditSession()
    s.open(target(DIR_A))
    s.close()
    expect(s.editing()).toBe(false)
    expect(s.target()).toBe(null)
  })
})

describe('ReadmeEditSession — queued edit intent', () => {
  it('honours an intent queued in the folder we are still in', () => {
    const s = new ReadmeEditSession()
    s.queue(DIR_A)
    expect(s.takeQueued(DIR_A)).toBe(true)
  })

  it('refuses an intent queued in a different folder', () => {
    const s = new ReadmeEditSession()
    s.queue(DIR_A)
    expect(s.takeQueued(DIR_B)).toBe(false)
  })

  it('consumes the intent, so it cannot fire twice', () => {
    const s = new ReadmeEditSession()
    s.queue(DIR_A)
    expect(s.takeQueued(DIR_A)).toBe(true)
    expect(s.takeQueued(DIR_A)).toBe(false)
  })

  it('discards a queued intent when the folder changes', () => {
    const s = new ReadmeEditSession()
    s.noteDir(DIR_A)
    s.queue(DIR_A)
    s.noteDir(DIR_B)
    // Even back in the original folder: the intent belonged to a visit that ended.
    expect(s.takeQueued(DIR_A)).toBe(false)
  })

  it('reports no intent when none was queued', () => {
    expect(new ReadmeEditSession().takeQueued(DIR_A)).toBe(false)
  })
})

describe('ReadmeEditSession — noteDir', () => {
  it('does not call the first folder a change', () => {
    const s = new ReadmeEditSession()
    expect(s.noteDir(DIR_A)).toBe(false)
  })

  it('does not call a repeat of the same folder a change', () => {
    const s = new ReadmeEditSession()
    s.noteDir(DIR_A)
    expect(s.noteDir(DIR_A)).toBe(false)
  })

  it('calls a move to another folder a change', () => {
    const s = new ReadmeEditSession()
    s.noteDir(DIR_A)
    expect(s.noteDir(DIR_B)).toBe(true)
  })

  it('calls a move back a change too', () => {
    const s = new ReadmeEditSession()
    s.noteDir(DIR_A)
    s.noteDir(DIR_B)
    expect(s.noteDir(DIR_A)).toBe(true)
  })
})

describe('ReadmeEditSession — leave()', () => {
  it('does nothing when no edit is open', async () => {
    const s = new ReadmeEditSession()
    const save = vi.fn(async (): Promise<ReadmeSaveOutcome> => 'saved')
    expect(await s.leave(save)).toBe(null)
    expect(save).not.toHaveBeenCalled()
  })

  it('saves, closes, and reports the file it saved', async () => {
    const s = new ReadmeEditSession()
    s.open(target(DIR_A))
    const result = await s.leave(async () => 'saved')
    expect(result).toEqual({ outcome: 'saved', name: 'Readme.md' })
    expect(s.editing()).toBe(false)
    expect(s.target()).toBe(null)
  })

  it('reports the name captured BEFORE the teardown cleared the target', async () => {
    const s = new ReadmeEditSession()
    s.open(target(DIR_A, row('README.md')))
    const result = await s.leave(async () => 'saved')
    expect(result?.name).toBe('README.md')
  })

  it('still closes when the save reports failure', async () => {
    const s = new ReadmeEditSession()
    s.open(target(DIR_A))
    const result = await s.leave(async () => 'failed')
    expect(result).toEqual({ outcome: 'failed', name: 'Readme.md' })
    // The whole point of this path: the exclusive lock must be released even when
    // the text could not be saved. A leaked lock is silent for its holder and
    // total for everyone else; losing the text is the lesser harm.
    expect(s.editing()).toBe(false)
  })

  it('still closes when the save THROWS, and reports failure', async () => {
    const s = new ReadmeEditSession()
    s.open(target(DIR_A))
    const result = await s.leave(async () => {
      throw new Error('network down')
    })
    expect(result).toEqual({ outcome: 'failed', name: 'Readme.md' })
    expect(s.editing()).toBe(false)
    expect(s.target()).toBe(null)
  })

  it('passes a clean session through without inventing a failure', async () => {
    const s = new ReadmeEditSession()
    s.open(target(DIR_A))
    expect(await s.leave(async () => 'clean')).toEqual({ outcome: 'clean', name: 'Readme.md' })
  })

  // Two folder hops in quick succession: the first leave() is still awaiting its
  // upload when the second arrives. Without the guard both see editing() true and
  // one edit becomes two uploads and two toasts.
  it('collapses two concurrent leaves into one save', async () => {
    const s = new ReadmeEditSession()
    s.open(target(DIR_A))
    let release!: (o: ReadmeSaveOutcome) => void
    const save = vi.fn(() => new Promise<ReadmeSaveOutcome>((resolve) => (release = resolve)))

    const first = s.leave(save)
    const second = await s.leave(save)
    expect(second).toBe(null)
    expect(save).toHaveBeenCalledTimes(1)

    release('saved')
    expect(await first).toEqual({ outcome: 'saved', name: 'Readme.md' })
  })

  it('accepts a new session after a leave completes', async () => {
    const s = new ReadmeEditSession()
    s.open(target(DIR_A))
    await s.leave(async () => 'saved')
    s.open(target(DIR_B))
    expect(s.editing()).toBe(true)
    expect(await s.leave(async () => 'saved')).toEqual({ outcome: 'saved', name: 'Readme.md' })
    expect(s.target()).toBe(null)
  })

  it('does not leave the guard stuck when the save throws', async () => {
    const s = new ReadmeEditSession()
    s.open(target(DIR_A))
    await s.leave(async () => {
      throw new Error('boom')
    })
    s.open(target(DIR_B))
    expect(await s.leave(async () => 'saved')).not.toBe(null)
  })
})
