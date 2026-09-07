// Pins the id-resolution contract of FavoritesService, which is the part of it that
// cannot fail visibly in a way anyone would attribute to favorites.
//
// A file with no `files` row carries a NEGATIVE id in the browse response
// (getProps sets `id: -stats.ino`). Adding a favorite is what materializes the row,
// and upstream hands the real id back in `{ fileId }`. Upstream's DELETE is
// id-addressed and rejects anything below 1 (DeleteFileFavoriteDto's @Min(1)), so a
// star-then-unstar before the next browse MUST send the id upstream returned, not the
// negative one the row still holds. Get that wrong and the star simply springs back
// on with a console error — no toast, no visible failure.
//
// It lives in the service rather than in a caller because the inspector panel has no
// access to the file browser's rows and so cannot adopt an id at all.
//
// No TestBed: the service takes one dependency (HttpClient). Same shape as
// layout-v2.service.spec.ts, for the same reason.

import { HttpClient } from '@angular/common/http'
import { Injector, runInInjectionContext } from '@angular/core'
import { of, throwError } from 'rxjs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FavoritesService } from './favorites.service'

interface Call {
  method: string
  url: string
  body?: unknown
}

function build(opts: { addFails?: boolean; removeFails?: boolean; resolvedId?: number } = {}) {
  const calls: Call[] = []
  const http = {
    get: (url: string) => {
      calls.push({ method: 'GET', url })
      return of([])
    },
    post: (url: string, body: unknown) => {
      calls.push({ method: 'POST', url, body })
      if (opts.addFails) return throwError(() => new Error('add failed'))
      return of({ fileId: opts.resolvedId ?? (body as { fileId: number }).fileId })
    },
    request: (method: string, url: string, options: { body?: unknown }) => {
      calls.push({ method: method.toUpperCase(), url, body: options?.body })
      if (opts.removeFails) return throwError(() => new Error('remove failed'))
      return of(undefined)
    }
  } as unknown as HttpClient

  const injector = Injector.create({ providers: [{ provide: HttpClient, useValue: http }] })
  const svc = runInInjectionContext(injector, () => new FavoritesService())
  return { svc, calls }
}

const lastBody = (calls: Call[], method: string): { fileId: number } => calls.filter((c) => c.method === method).at(-1)!.body as { fileId: number }

describe('FavoritesService — id resolution', () => {
  let consoleError: typeof console.error

  beforeEach(() => {
    // The service logs failures; the rollback cases below expect them.
    consoleError = console.error
    console.error = () => undefined
  })

  afterEach(() => {
    console.error = consoleError
  })

  it('sends the REAL id on removal after adding an unmaterialized (negative-id) file', () => {
    const { svc, calls } = build({ resolvedId: 474 })
    const row = { id: -43582000, isFavorite: false }

    svc.toggle('files/personal/x.md', row)
    expect(lastBody(calls, 'POST').fileId).toBe(-43582000)
    expect(svc.isFavorite(row)).toBe(true)

    // The row still carries its negative id — nothing rewrites it.
    svc.toggle('files/personal/x.md', row)

    expect(lastBody(calls, 'DELETE').fileId).toBe(474)
    // The value @Min(1) would have rejected.
    expect(lastBody(calls, 'DELETE').fileId).toBeGreaterThan(0)
    expect(svc.isFavorite(row)).toBe(false)
  })

  it('keeps the star on under BOTH ids until a browse response lands', () => {
    const { svc } = build({ resolvedId: 474 })
    const row = { id: -43582000, isFavorite: false }

    svc.toggle('files/personal/x.md', row)

    expect(svc.isFavorite(row)).toBe(true)
    // The same file as the next browse will present it.
    expect(svc.isFavorite({ id: 474, isFavorite: false })).toBe(true)
  })

  it('addresses an already-materialized file by its own id', () => {
    const { svc, calls } = build()
    const row = { id: 473, isFavorite: true }

    svc.toggle('files/personal/y.md', row)

    expect(lastBody(calls, 'DELETE').fileId).toBe(473)
  })

  it('forgets the resolved id once a browse response supersedes it', () => {
    const { svc, calls } = build({ resolvedId: 474 })
    const row = { id: -43582000, isFavorite: false }
    svc.toggle('files/personal/x.md', row)

    // A browse landed: rows now carry real ids and the server's own flag.
    svc.clearOverrides()
    svc.toggle('files/personal/x.md', { id: 474, isFavorite: true })

    expect(lastBody(calls, 'DELETE').fileId).toBe(474)
  })

  it('rolls the star back when the add fails', () => {
    const { svc } = build({ addFails: true })
    const row = { id: 12, isFavorite: false }

    svc.toggle('files/personal/z.md', row)

    expect(svc.isFavorite(row)).toBe(false)
  })

  it('rolls the star back on when the remove fails', () => {
    const { svc } = build({ removeFails: true })
    const row = { id: 12, isFavorite: true }

    svc.toggle('files/personal/z.md', row)

    expect(svc.isFavorite(row)).toBe(true)
  })

  it('prefers an in-flight override over the row it was given', () => {
    const { svc } = build()
    // Server says starred, a pending toggle says otherwise.
    const row = { id: 99, isFavorite: true }
    svc.toggle('files/personal/q.md', row)
    expect(svc.isFavorite(row)).toBe(false)
    expect(svc.isFavorite({ id: 99, isFavorite: true })).toBe(false)
  })

  it('removeById addresses a disabled favorite that has no usable path', () => {
    const { svc, calls } = build()
    svc.removeById(41)
    expect(lastBody(calls, 'DELETE').fileId).toBe(41)
  })
})
