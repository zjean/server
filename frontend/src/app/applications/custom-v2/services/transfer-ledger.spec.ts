// The rules that decide whether the upload dock is allowed to open.
//
// Every case here is a shipped bug: the dock rose out of the corner on a fresh load to
// report a folder deletion from the previous evening, and closing it did not help,
// because `GET /files/tasks` re-served the same finished tasks for the next 24 hours
// (`CACHE_TASK_TTL`). None of it fails a build or a type check — the old dock read
// `store.filesEndedTasks` and every entry in it was, technically, a finished task.
//
// Tested directly rather than through TransfersService: the service's half is
// `toSignal` plumbing, and the decisions are all here.

import { describe, expect, it } from 'vitest'
import { TransferLedger } from './transfer-ledger'

const task = (id: string) => ({ id, name: `${id}.bin` })

describe('TransferLedger', () => {
  it('does not announce a task that was already finished when it first appeared', () => {
    const ledger = new TransferLedger()

    // What a page load looks like: `loadAll` seeds the ended list from the server, and
    // nothing was ever active.
    expect(ledger.announceable([task('yesterday-1'), task('yesterday-2')])).toEqual([])
  })

  it('announces a task it watched run', () => {
    const ledger = new TransferLedger()

    ledger.watch([task('upload-1')])

    expect(ledger.announceable([task('upload-1')])).toEqual([task('upload-1')])
  })

  it('announces only the watched half of a mixed list', () => {
    const ledger = new TransferLedger()

    // The realistic case, and the one the old dock got wrong: the store holds both at
    // once, because an upload during this session lands in a list the server has
    // already filled with a day of history.
    ledger.watch([task('upload-1')])

    expect(ledger.announceable([task('yesterday-1'), task('upload-1')])).toEqual([task('upload-1')])
  })

  it('keeps a dismissed task dismissed however often it is re-reported', () => {
    const ledger = new TransferLedger()
    ledger.watch([task('upload-1')])
    const ended = [task('upload-1')]

    ledger.dismiss(ledger.announceable(ended))

    // Three server polls later, still the same answer. The old dock kept one boolean
    // and reopened here.
    expect(ledger.announceable(ended)).toEqual([])
    expect(ledger.announceable(ended)).toEqual([])
  })

  it('reopens for a new task after a dismissal', () => {
    const ledger = new TransferLedger()
    ledger.watch([task('upload-1')])
    ledger.dismiss([task('upload-1')])

    ledger.watch([task('upload-2')])

    // Both are in the ended list; only the undismissed one is news.
    expect(ledger.announceable([task('upload-1'), task('upload-2')])).toEqual([task('upload-2')])
  })

  it('dismisses only what was passed to it, not everything watched', () => {
    const ledger = new TransferLedger()
    ledger.watch([task('a'), task('b')])

    // `b` finishes after the user closes `a` — a dismissal is a statement about a
    // batch, not a mute button for the session.
    ledger.dismiss([task('a')])

    expect(ledger.announceable([task('a'), task('b')])).toEqual([task('b')])
  })

  it('preserves the order it is given', () => {
    const ledger = new TransferLedger()
    ledger.watch([task('a'), task('b'), task('c')])

    // The store prepends, so index 0 is the newest — the dock prints them in that
    // order and filtering must not reshuffle it.
    expect(ledger.announceable([task('c'), task('b'), task('a')]).map((t) => t.id)).toEqual(['c', 'b', 'a'])
  })

  it('watches a task seen active across separate emissions', () => {
    const ledger = new TransferLedger()

    // A batch of two uploads emits repeatedly as progress mutates and as each one
    // leaves the active set. The second emission does not un-watch the first task.
    ledger.watch([task('a'), task('b')])
    ledger.watch([task('b')])
    ledger.watch([])

    expect(ledger.announceable([task('a'), task('b')]).map((t) => t.id)).toEqual(['a', 'b'])
  })
})
