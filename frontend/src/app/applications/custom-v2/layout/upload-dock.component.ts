import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core'
import { FileTask, FileTaskStatus } from '@sync-in-server/backend/src/applications/files/models/file-task'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe, L10nTranslationService } from 'angular-l10n'
import { ToBytesPipe } from '../../../common/pipes/to-bytes.pipe'
import { FilesTasksService } from '../../files/services/files-tasks.service'
import { ButtonComponent } from '../components/button.component'
import { IconButtonComponent } from '../components/icon-button.component'
import { IconV2Component } from '../icons/icon-v2.component'
import { TransfersService } from '../services/transfers.service'

/**
 * The upload dock (D8) — bottom-right, 360px, collapsible to one line.
 *
 * It replaces the top-bar pill and its popover. The design's reason is that the
 * aggregate belongs where it does not compete with navigation: a pill in the chrome
 * has to be noticed and clicked, and an upload is the one background job that a user
 * wants to watch without doing either. So the dock appears on its own when a transfer
 * starts, states the aggregate in one line, and collapses to just that line.
 *
 * Two of D8's controls are absent because nothing can implement them:
 *
 *  • **Pause.** The upload service registers a CANCELLATION per task and nothing else
 *    (`files-tasks.service.ts:152`); an HTTP upload in flight cannot be suspended and
 *    resumed. So the per-row action is Cancel, which is real, and the header has none.
 *  • **Retry** on a failed row. An upload's source is a `File` from the picker, which
 *    the browser does not keep once the dialog closes, so there is nothing to send
 *    again. The row states the failure reason instead — the actionable half.
 *
 * It also shows a rate and an ETA, which nothing reported before; `TransfersService`
 * derives both from the byte counters over a trailing window.
 */
@Component({
  selector: 'app-v2-upload-dock',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './upload-dock.component.html',
  styleUrl: './upload-dock.component.scss',
  imports: [ButtonComponent, IconButtonComponent, IconV2Component, ToBytesPipe, L10nTranslatePipe]
})
export class UploadDockComponent {
  private readonly transfers = inject(TransfersService)
  private readonly tasks = inject(FilesTasksService)
  private readonly translation = inject(L10nTranslationService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  protected readonly active = this.transfers.active
  protected readonly ended = this.transfers.ended
  protected readonly agg = this.transfers.aggregate

  protected readonly collapsed = signal(false)

  // Dismissal is per task id and lives in TransfersService, so `ended()` is already
  // only what this dock may still announce — nothing here has to remember a boolean.
  protected readonly visible = computed(() => this.agg().active > 0 || this.ended().length > 0)

  protected readonly idleWithFailures = computed(() => this.agg().active === 0 && this.agg().failed > 0)
  // A finished batch is not "working": the accent tint means in-flight, so a completed
  // dock takes the success pair instead. Without this a done dock read as still busy.
  protected readonly idleAndClean = computed(() => this.agg().active === 0 && this.agg().failed === 0)

  protected readonly markGlyph = computed(() => {
    if (this.agg().active > 0) return 'upload' as const
    return this.agg().failed > 0 ? ('info' as const) : ('check' as const)
  })

  protected readonly headline = computed(() => {
    const a = this.agg()
    if (a.active > 0) return 'v2_uploading_n_of_m'
    if (a.failed > 0) return a.failed === 1 ? 'v2_transfer_one_failed' : 'v2_transfer_n_failed'
    return this.ended().length === 1 ? 'v2_transfer_one_done' : 'v2_transfer_n_done'
  })

  protected readonly headlineParams = computed(() => {
    const a = this.agg()
    // `n of m` counts finished-plus-running, which is what a batch of five uploads
    // means by "3 of 5" — not the number still going.
    return { n: a.total - a.active + 1, m: a.total, nb: a.failed > 0 ? a.failed : this.ended().length }
  })

  /**
   * `4.2 MB/s · 12 s left`, and only the parts that are true.
   *
   * The rate needs two samples and the ETA needs a rate, so early in a transfer there
   * is neither; the byte counter is shown instead of a made-up figure. Composed here
   * rather than in the template because it is three optional fragments joined by a
   * separator, which reads as noise in markup.
   */
  protected readonly subline = computed(() => {
    const a = this.agg()
    const parts: string[] = []
    if (a.bytesTotal > 0) parts.push(`${this.bytes(a.bytesDone)} / ${this.bytes(a.bytesTotal)}`)
    if (a.bytesPerSecond) parts.push(`${this.bytes(a.bytesPerSecond)}/s`)
    if (a.secondsLeft !== null) parts.push(this.eta(a.secondsLeft))
    return parts.join(' · ')
  })

  private readonly toBytes = new ToBytesPipe()

  constructor() {
    // A new transfer re-expands the dock: the user collapsed the LAST batch, not this
    // one. It does not need to un-dismiss anything — a new task has a new id, and the
    // ledger only ever silences the ids that were dismissed.
    effect(() => {
      const active = this.agg().active
      untracked(() => {
        if (active > 0) this.collapsed.set(false)
      })
    })
  }

  protected percentOf(t: FileTask): number {
    return this.transfers.percentOf(t)
  }

  protected isError(t: FileTask): boolean {
    return t.status === FileTaskStatus.ERROR
  }

  protected canCancel(t: FileTask): boolean {
    return this.tasks.canCancel(t)
  }

  protected cancel(t: FileTask): void {
    this.tasks.cancel(t)
  }

  /**
   * `Clear done` deletes the finished tasks, on the server as well as here.
   *
   * That is what classic's own button does (`FilesTasksService.removeAll`, from the
   * task sidebar), and it is the difference between this and the `×` beside it: the
   * server holds finished tasks for a day, so a clear that only emptied the client's
   * list left them to be re-reported on the next load. Scoped to the ids the dock is
   * showing rather than classic's delete-everything, since the dock is not the only
   * thing that reads that list.
   *
   * Safe for a compress-to-download task, whose archive the server deletes along with
   * it: v2 downloads that archive the moment the task completes (`file-browser.base`
   * subscribes to `archiveId`), so by the time a row is clearable the file has been
   * fetched.
   */
  protected clearDone(): void {
    this.tasks.removeSelectedTasks(this.ended())
  }

  protected dismiss(): void {
    this.transfers.dismissEnded()
  }

  private bytes(n: number): string {
    return this.toBytes.transform(n, 1, true)
  }

  // Minutes past 90 seconds — "104 s left" reads as noise. Translated rather than
  // built as an English string: the number is machine output, the word "left" is not.
  private eta(seconds: number): string {
    return seconds < 90
      ? this.translation.translate('v2_eta_seconds', { n: seconds })
      : this.translation.translate('v2_eta_minutes', { n: Math.round(seconds / 60) })
  }
}
