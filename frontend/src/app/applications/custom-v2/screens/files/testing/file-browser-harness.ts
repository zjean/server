// Test support for the two v2 file-browser screens (personal + space-files).
//
// WHY THIS EXISTS
// ---------------
// These screens share ~61 methods and were duplicated verbatim (issue #346).
// Before consolidating them we pin their *current* public behaviour: which
// backend call each method makes, with which URL / DTO / sentinel values, and
// what it does to component state. Anything the consolidation changes should
// fail one of these specs.
//
// WHY NOT TestBed
// ---------------
// The repo has no frontend test runner and no jsdom/happy-dom installed. Rather
// than add dependencies, the harness builds a plain `Injector` and instantiates
// the component class inside `runInInjectionContext` — no template compilation,
// no DOM, no platform. `effect()` only needs two internal Angular tokens
// (`ɵEffectScheduler` + `ɵChangeDetectionScheduler`), which we stub so effects
// run when `flushEffects()` is called. Everything under test here is component
// *logic*, not rendering, so that is sufficient.
//
// The components are SSR-guarded (`typeof window === 'undefined'` /
// `typeof navigator === 'undefined'`), so with no globals defined they take the
// no-browser branch deterministically. Tests that need `window` install a
// recording stub via `installWindowStub()`.

import { HttpClient } from '@angular/common/http'
import { DestroyRef, Injector, runInInjectionContext, signal, ɵChangeDetectionScheduler, ɵEffectScheduler } from '@angular/core'
import { L10N_LOCALE } from 'angular-l10n'
import type { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { BehaviorSubject, Observable, of, Subject, throwError } from 'rxjs'
import { StoreService } from '../../../../../store/store.service'
import { FilesService } from '../../../../files/services/files.service'
import { FilesUploadService } from '../../../../files/services/files-upload.service'
import { SpacesService } from '../../../../spaces/services/spaces.service'
import { CompressDialogService } from '../../../components/compress-dialog.service'
import { ConfirmDialogService } from '../../../components/confirm-dialog.service'
import { LinkDialogService } from '../../../components/link-dialog.service'
import { PromptDialogService } from '../../../components/prompt-dialog.service'
import { ShareDialogService } from '../../../components/share-dialog.service'
import { ToastService } from '../../../components/toast.service'
import { TreePickerService } from '../../../components/tree-picker.service'
import { V2BreadcrumbService } from '../../../layout/breadcrumb.service'
import { DockRailService } from '../../../layout/dock-rail.service'
import { FavoritesService } from '../../../services/favorites.service'
import { FolderSizeService } from '../../../services/folder-size.service'
import { V2DragService } from '../../../services/drag.service'
import { ActivatedRoute, Router } from '@angular/router'

// ---------------------------------------------------------------------------
// Call recording
// ---------------------------------------------------------------------------

export interface RecordedCall {
  target: string
  args: unknown[]
}

export class CallLog {
  readonly calls: RecordedCall[] = []

  record(target: string, ...args: unknown[]): void {
    this.calls.push({ target, args })
  }

  /** Every recorded call to `target`, in order. */
  of(target: string): RecordedCall[] {
    return this.calls.filter((c) => c.target === target)
  }

  /** The single recorded call to `target`; fails loudly if there is not exactly one. */
  only(target: string): RecordedCall {
    const found = this.of(target)
    if (found.length !== 1) throw new Error(`expected exactly 1 call to ${target}, got ${found.length}`)
    return found[0]
  }

  count(target: string): number {
    return this.of(target).length
  }

  /** Ordered list of recorded target names — for asserting side-effect sequences. */
  sequence(): string[] {
    return this.calls.map((c) => c.target)
  }

  clear(): void {
    this.calls.length = 0
  }
}

// ---------------------------------------------------------------------------
// Angular internals: run effects on demand
// ---------------------------------------------------------------------------

interface SchedulableEffectLike {
  run(): void
}

class StubEffectScheduler {
  private readonly pending = new Set<SchedulableEffectLike>()

  add(e: SchedulableEffectLike): void {
    this.pending.add(e)
  }

  schedule(e: SchedulableEffectLike): void {
    this.pending.add(e)
  }

  remove(e: SchedulableEffectLike): void {
    this.pending.delete(e)
  }

  flush(): void {
    // Effects can dirty other effects; loop until quiescent (bounded, so a
    // genuine cycle surfaces as a test failure rather than a hang).
    for (let pass = 0; pass < 20 && this.pending.size > 0; pass++) {
      const batch = [...this.pending]
      this.pending.clear()
      for (const e of batch) e.run()
    }
  }
}

class StubChangeDetectionScheduler {
  runningTick = false
  notify(): void {
    // no-op: nothing is rendering
  }
}

// ---------------------------------------------------------------------------
// Route stubs
// ---------------------------------------------------------------------------

/** Minimal stand-in for the `path` field of an Angular UrlSegment. */
export interface UrlSegmentLike {
  path: string
}

export function urlSegments(...paths: string[]): UrlSegmentLike[] {
  return paths.map((path) => ({ path }))
}

// ---------------------------------------------------------------------------
// window stub
// ---------------------------------------------------------------------------

export interface WindowStub {
  opened: { url: string; target?: string; features?: string }[]
  storage: Map<string, string>
}

/**
 * Installs a recording `window` (with localStorage) on globalThis and returns
 * both the recorder and an uninstall function. The components guard every
 * browser access behind `typeof window === 'undefined'`, so the default state
 * of the harness (no window at all) exercises the SSR branch; call this when a
 * spec needs the browser branch.
 */
export function installWindowStub(initialStorage: Record<string, string> = {}): { win: WindowStub; restore: () => void } {
  const storage = new Map<string, string>(Object.entries(initialStorage))
  const win: WindowStub = { opened: [], storage }
  const g = globalThis as Record<string, unknown>
  const had = 'window' in g
  const previous = g['window']
  g['window'] = {
    localStorage: {
      getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k)
    },
    open: (url: string, target?: string, features?: string) => {
      win.opened.push({ url, target, features })
      return null
    }
  }
  return {
    win,
    restore: () => {
      if (had) g['window'] = previous
      else delete g['window']
    }
  }
}

// ---------------------------------------------------------------------------
// Service doubles
// ---------------------------------------------------------------------------

export interface DialogQueue<T> {
  /** Values returned by successive `open()` calls; exhausted queue returns `fallback`. */
  results: T[]
  fallback: T
}

export class HarnessDeps {
  readonly log = new CallLog()

  // --- HttpClient -------------------------------------------------------
  /** URL -> response body for GET. */
  readonly httpGetResponses = new Map<string, unknown>()
  /** When set, every GET fails with this status instead of resolving. */
  httpGetError: number | null = null
  /** URL -> response body for POST. */
  readonly httpPostResponses = new Map<string, unknown>()
  httpPostError: number | null = null

  // --- dialog results ---------------------------------------------------
  confirmResults: DialogQueue<boolean> = { results: [], fallback: false }
  promptResults: DialogQueue<string | null> = { results: [], fallback: null }
  treePickerResults: DialogQueue<{ path: string } | null> = { results: [], fallback: null }
  compressResults: DialogQueue<Record<string, unknown> | null> = { results: [], fallback: null }

  // --- FilesService behaviour -------------------------------------------
  /** `rename` / `make` resolve by default; set to a status to make them error. */
  renameError: { status: number; message: string } | null = null
  makeError: { status: number; message: string } | null = null
  /** Value assigned to FilesService.currentRoute, in assignment order. */
  readonly currentRouteWrites: string[] = []

  // --- observable inputs ------------------------------------------------
  readonly routeUrl = new BehaviorSubject<UrlSegmentLike[]>([])
  readonly routeParams = new BehaviorSubject<Record<string, string>>({})
  readonly filesOnEvent = new Subject<unknown>()
  readonly user = new BehaviorSubject<{ id: number } | null>(null)
  readonly spaces = new BehaviorSubject<{ alias: string; name: string }[]>([])

  // --- misc state -------------------------------------------------------
  readonly favoriteIds = new Set<number>()
  readonly dockSelected = signal<unknown>(null)
  readonly serverConfig = signal({ files: { editors: { onlyoffice: false, eurooffice: false, collabora: false } } })
  dragPayload: { files: FileProps[]; sourceDir: string; draggedIds: Set<number> } | null = null
  dragCanDropOnFile = true
  dropHandler: ((targetPath: string, files: FileProps[]) => void) | null = null

  private next<T>(q: DialogQueue<T>): T {
    return q.results.length > 0 ? (q.results.shift() as T) : q.fallback
  }

  private httpError(status: number, message: string): Observable<never> {
    return throwError(() => ({ status, error: { message } }))
  }

  buildProviders(): { provide: unknown; useValue: unknown }[] {
    const log = this.log

    const http = {
      get: (url: string) => {
        log.record('http.get', url)
        if (this.httpGetError !== null) return this.httpError(this.httpGetError, 'boom')
        return of(this.httpGetResponses.has(url) ? this.httpGetResponses.get(url) : { files: [] })
      },
      post: (url: string, body: unknown) => {
        log.record('http.post', url, body)
        if (this.httpPostError !== null) return this.httpError(this.httpPostError, 'post failed')
        return of(this.httpPostResponses.has(url) ? this.httpPostResponses.get(url) : {})
      }
    }

    const filesServiceTarget = {
      currentRoute: '',
      copyMove: (files: unknown, dst: string, type: unknown) => {
        log.record('files.copyMove', files, dst, type)
        return Promise.resolve()
      },
      delete: (files: unknown) => log.record('files.delete', files),
      compress: (dto: unknown) => log.record('files.compress', dto),
      decompress: (file: unknown) => log.record('files.decompress', file),
      rename: (file: unknown, name: string, overwrite: boolean) => {
        log.record('files.rename', file, name, overwrite)
        if (this.renameError) return this.httpError(this.renameError.status, this.renameError.message)
        return of({})
      },
      make: (type: string, name: string, dirPath: string, asCallBack: boolean) => {
        log.record('files.make', type, name, dirPath, asCallBack)
        if (this.makeError) return this.httpError(this.makeError.status, this.makeError.message)
        return of({})
      },
      downloadFromUrl: (url: string, name: string) => log.record('files.downloadFromUrl', url, name),
      downloadTaskArchive: (taskId: string) => log.record('files.downloadTaskArchive', taskId),
      getSize: () => of(0)
    }
    // currentRoute is a plain field the screens *assign*; record the writes so
    // specs can assert the "set currentRoute, then fire task" sequence that the
    // classic UI depends on.
    const currentRouteWrites = this.currentRouteWrites
    const filesService = new Proxy(filesServiceTarget as Record<string, unknown>, {
      set(target, prop, value) {
        if (prop === 'currentRoute') {
          currentRouteWrites.push(value as string)
          log.record('files.currentRoute=', value)
        }
        target[prop as string] = value
        return true
      }
    })

    return [
      { provide: ɵEffectScheduler, useValue: this.effects },
      { provide: ɵChangeDetectionScheduler, useValue: new StubChangeDetectionScheduler() },
      { provide: DestroyRef, useValue: { onDestroy: (cb: () => void) => (this.destroyCallbacks.push(cb), () => undefined) } },
      { provide: L10N_LOCALE, useValue: { language: 'en' } },
      { provide: HttpClient, useValue: http },
      { provide: ActivatedRoute, useValue: { url: this.routeUrl.asObservable(), params: this.routeParams.asObservable() } },
      {
        provide: Router,
        useValue: {
          navigate: (commands: unknown[], extras?: unknown) => {
            log.record('router.navigate', commands, extras)
            return Promise.resolve(true)
          }
        }
      },
      { provide: V2BreadcrumbService, useValue: { setBreadcrumbs: (segs: unknown) => log.record('breadcrumbs.set', segs), clear: () => undefined } },
      { provide: FilesService, useValue: filesService },
      {
        provide: FolderSizeService,
        useValue: {
          clear: () => log.record('folderSize.clear'),
          state: (id: number) => ({ status: 'idle', id }),
          compute: (file: unknown, path: string) => log.record('folderSize.compute', file, path)
        }
      },
      {
        provide: FavoritesService,
        useValue: {
          isFavorite: (id: number) => this.favoriteIds.has(id),
          toggle: (path: string, id: number, add: boolean) => log.record('favorites.toggle', path, id, add),
          loadFavoriteIds: () => log.record('favorites.loadFavoriteIds')
        }
      },
      {
        provide: FilesUploadService,
        useValue: {
          addFiles: (files: unknown, overwrite: boolean) => {
            log.record('upload.addFiles', files, overwrite)
            return Promise.resolve()
          },
          onDropFiles: (ev: unknown, exist: unknown) => log.record('upload.onDropFiles', ev, exist)
        }
      },
      { provide: SpacesService, useValue: { listSpaces: () => (log.record('spaces.listSpaces'), this.spaces.asObservable()) } },
      {
        provide: ConfirmDialogService,
        useValue: {
          open: (opts: unknown) => {
            log.record('confirmDialog.open', opts)
            return Promise.resolve(this.next(this.confirmResults))
          }
        }
      },
      {
        provide: TreePickerService,
        useValue: {
          open: (opts: unknown) => {
            log.record('treePicker.open', opts)
            return Promise.resolve(this.next(this.treePickerResults))
          }
        }
      },
      {
        provide: PromptDialogService,
        useValue: {
          open: (opts: unknown) => {
            log.record('promptDialog.open', opts)
            return Promise.resolve(this.next(this.promptResults))
          }
        }
      },
      {
        provide: CompressDialogService,
        useValue: {
          open: (opts: unknown) => {
            log.record('compressDialog.open', opts)
            return Promise.resolve(this.next(this.compressResults))
          }
        }
      },
      {
        provide: LinkDialogService,
        useValue: {
          open: (opts: unknown) => {
            log.record('linkDialog.open', opts)
            return Promise.resolve(undefined)
          }
        }
      },
      {
        provide: ShareDialogService,
        useValue: {
          open: (opts: unknown) => {
            log.record('shareDialog.open', opts)
            return Promise.resolve(undefined)
          }
        }
      },
      {
        provide: ToastService,
        useValue: {
          success: (msg: string, args?: unknown) => log.record('toast.success', msg, args),
          error: (msg: string, args?: unknown) => log.record('toast.error', msg, args),
          info: (msg: string, args?: unknown) => log.record('toast.info', msg, args)
        }
      },
      { provide: StoreService, useValue: { filesOnEvent: this.filesOnEvent, user: this.user, server: this.serverConfig } },
      {
        provide: DockRailService,
        useValue: {
          setTabs: (tabs: unknown) => log.record('dock.setTabs', tabs),
          currentSelected: this.dockSelected,
          clear: () => log.record('dock.clear')
        }
      },
      {
        provide: V2DragService,
        useValue: {
          registerDropHandler: (handler: (targetPath: string, files: FileProps[]) => void) => {
            this.dropHandler = handler
            log.record('drag.registerDropHandler')
            return () => {
              this.dropHandler = null
              log.record('drag.unregisterDropHandler')
            }
          },
          start: (files: unknown, sourceDir: string) => log.record('drag.start', files, sourceDir),
          end: () => log.record('drag.end'),
          canDropOnFile: () => this.dragCanDropOnFile,
          payload: () => this.dragPayload,
          dropOnPath: (p: string) => log.record('drag.dropOnPath', p),
          canDropOnPath: () => true,
          active: () => this.dragPayload !== null
        }
      }
    ]
  }

  readonly effects = new StubEffectScheduler()
  readonly destroyCallbacks: (() => void)[] = []

  flushEffects(): void {
    this.effects.flush()
  }
}

// ---------------------------------------------------------------------------
// Component factory
// ---------------------------------------------------------------------------

export interface MountResult<T> {
  component: T
  deps: HarnessDeps
  /** Run pending effects. */
  flush(): void
  /** Let queued microtasks (dialog promises) settle, then run effects. */
  settle(): Promise<void>
}

export function mount<T>(ctor: new () => T, configure?: (deps: HarnessDeps) => void): MountResult<T> {
  const deps = new HarnessDeps()
  configure?.(deps)
  const injector = Injector.create({ providers: deps.buildProviders() as never })
  const component = runInInjectionContext(injector, () => new ctor())
  const flush = () => deps.flushEffects()
  return {
    component,
    deps,
    flush,
    settle: async () => {
      // Two ticks: dialog promise resolution frequently chains a second await.
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      deps.flushEffects()
    }
  }
}

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

export function file(overrides: Partial<FileProps> & { id: number; name: string }): FileProps {
  return {
    id: overrides.id,
    name: overrides.name,
    isDir: overrides.isDir ?? false,
    mime: overrides.mime ?? 'text/plain',
    size: overrides.size ?? 100,
    ctime: overrides.ctime ?? 1_700_000_000_000,
    mtime: overrides.mtime ?? 1_700_000_000_000,
    ...overrides
  } as FileProps
}

export const FIXTURE_FILES: FileProps[] = [
  file({ id: 1, name: 'alpha.txt', size: 10 }),
  file({ id: 2, name: 'beta', isDir: true, mime: 'directory', size: 4096 }),
  file({ id: 3, name: 'gamma.pdf', mime: 'application/pdf', size: 200 }),
  file({ id: 4, name: 'delta.zip', mime: 'application/zip', size: 300 })
]
