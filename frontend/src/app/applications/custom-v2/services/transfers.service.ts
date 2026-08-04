import { computed, effect, inject, Injectable, signal } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { FILE_OPERATION } from '@sync-in-server/backend/src/applications/files/constants/operations'
import { FileTask, FileTaskStatus } from '@sync-in-server/backend/src/applications/files/models/file-task'
import { StoreService } from '../../../store/store.service'

/** What the dock's header line and a tile's bar are drawn from. */
export interface TransferAggregate {
  /** Tasks still running. */
  active: number
  /** Running plus finished, i.e. the denominator in "3 of 5". */
  total: number
  bytesDone: number
  bytesTotal: number
  /** 0–100, or null when no task reports a total size. */
  percent: number | null
  /** Bytes per second over a short trailing window, or null until measurable. */
  bytesPerSecond: number | null
  /** Seconds remaining at the current rate, or null when it cannot be computed. */
  secondsLeft: number | null
  failed: number
}

/** How long a sample stays in the rate window. */
const RATE_WINDOW_MS = 4000
/** Progress is mutated in place, so the view has to re-read it on a timer. */
const TICK_MS = 250

/**
 * One source of truth for in-flight transfers.
 *
 * It exists because THREE surfaces now need the same numbers — the upload dock, the
 * gallery's in-place tiles, and whatever asks "is anything uploading here" — and each
 * of them otherwise has to re-solve the same two problems:
 *
 *  • **Progress is written by MUTATING `task.props.size` in place.** The upstream
 *    `FilesUploadService` does not re-emit `filesActiveTasks` per progress event, and
 *    classic gets away with it because zone-based change detection re-reads the object
 *    on every tick. An OnPush view reading a signal does not, so it freezes on the
 *    first snapshot. The fix is a timer that republishes a fresh array reference, and
 *    it belongs in one place rather than in each consumer (the transfers popover had
 *    the only copy, with the comment that explains it).
 *  • **Rate and ETA are not reported by anything.** The design's dock says
 *    "4.2 MB/s · 12 s left", so they are derived here from the byte counters over a
 *    trailing window — a single instantaneous delta reads as noise on a slow link.
 */
@Injectable({ providedIn: 'root' })
export class TransfersService {
  private readonly store = inject(StoreService)

  private readonly activeRaw = toSignal(this.store.filesActiveTasks, { initialValue: [] as FileTask[] })
  readonly ended = toSignal(this.store.filesEndedTasks, { initialValue: [] as FileTask[] })

  private readonly tick = signal(0)
  private readonly hasActive = computed(() => this.activeRaw().length > 0)

  /** Active tasks, re-published on every tick so mutated progress is visible. */
  readonly active = computed<FileTask[]>(() => {
    this.tick()
    return [...this.activeRaw()]
  })

  // Trailing samples of (timestamp, bytes) used for the rate. Plain state rather than
  // a signal: it is written from the same effect that ticks, and reading it inside a
  // computed must not create a dependency loop.
  private samples: { at: number; bytes: number }[] = []

  constructor() {
    effect((onCleanup) => {
      if (!this.hasActive()) {
        this.samples = []
        return
      }
      const id = window.setInterval(() => {
        this.sample()
        this.tick.update((v) => v + 1)
      }, TICK_MS)
      onCleanup(() => window.clearInterval(id))
    })
  }

  /** Active UPLOAD tasks whose destination is exactly this folder. */
  uploadsIn(dirPath: string): FileTask[] {
    return this.active().filter((t) => t.type === FILE_OPERATION.UPLOAD && t.path === dirPath)
  }

  readonly aggregate = computed<TransferAggregate>(() => {
    const active = this.active()
    const ended = this.ended()
    const bytesDone = active.reduce((n, t) => n + (t.props.size ?? 0), 0)
    const bytesTotal = active.reduce((n, t) => n + (t.props.totalSize ?? 0), 0)
    const rate = this.rate()
    const remaining = bytesTotal - bytesDone
    return {
      active: active.length,
      total: active.length + ended.length,
      bytesDone,
      bytesTotal,
      percent: bytesTotal > 0 ? Math.min(100, Math.round((bytesDone / bytesTotal) * 100)) : null,
      bytesPerSecond: rate,
      // Only when both halves are real: a rate of zero would divide to Infinity, and
      // "∞ left" is worse than saying nothing.
      secondsLeft: rate && rate > 0 && remaining > 0 ? Math.ceil(remaining / rate) : null,
      failed: ended.filter((t) => t.status === FileTaskStatus.ERROR).length
    }
  })

  /** Per-task progress, 0–100. Zero when the task reports no total. */
  percentOf(task: FileTask): number {
    const total = task.props.totalSize
    if (!total) return 0
    return Math.min(100, Math.round(((task.props.size ?? 0) / total) * 100))
  }

  private sample(): void {
    const bytes = this.activeRaw().reduce((n, t) => n + (t.props.size ?? 0), 0)
    const now = Date.now()
    this.samples.push({ at: now, bytes })
    // Drop anything older than the window, keeping at least two points so a rate is
    // still computable at the moment the window slides.
    while (this.samples.length > 2 && now - this.samples[0].at > RATE_WINDOW_MS) this.samples.shift()
  }

  private rate(): number | null {
    // Read the tick so the rate recomputes with everything else.
    this.tick()
    if (this.samples.length < 2) return null
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    const seconds = (last.at - first.at) / 1000
    if (seconds <= 0) return null
    const delta = last.bytes - first.bytes
    // A negative delta means a task ended and left the active set — the counter is not
    // monotonic across set changes, so report nothing rather than a negative speed.
    return delta > 0 ? delta / seconds : null
  }
}
