import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, HostListener, inject, signal } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { FILE_OPERATION } from '@sync-in-server/backend/src/applications/files/constants/operations'
import { FileTask, FileTaskStatus } from '@sync-in-server/backend/src/applications/files/models/file-task'
import { ToBytesPipe } from '../../../common/pipes/to-bytes.pipe'
import { StoreService } from '../../../store/store.service'
import { ButtonComponent } from '../components/button.component'
import { IconButtonComponent } from '../components/icon-button.component'
import { PillComponent } from '../components/pill.component'
import { IconV2Component } from '../icons/icon-v2.component'

@Component({
  selector: 'app-v2-transfers-popover',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './transfers-popover.component.html',
  styleUrl: './transfers-popover.component.scss',
  imports: [IconV2Component, IconButtonComponent, ButtonComponent, PillComponent, ToBytesPipe, L10nTranslateDirective, L10nTranslatePipe]
})
export class TransfersPopoverComponent {
  private readonly store = inject(StoreService)
  private readonly host = inject(ElementRef<HTMLElement>)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  protected readonly open = signal(false)
  protected readonly activeTasksRaw = toSignal(this.store.filesActiveTasks, { initialValue: [] as FileTask[] })
  protected readonly endedTasks = toSignal(this.store.filesEndedTasks, { initialValue: [] as FileTask[] })
  protected readonly syncCount = toSignal(this.store.clientSyncTasksCount, { initialValue: 0 })

  // Upload progress is written by mutating task.props.size in place — the
  // upstream FilesUploadService does not re-emit filesActiveTasks on each
  // progress event. Classic UI's zone-driven change detection picks the
  // mutation up on the next tick; this OnPush + toSignal view does not, so
  // the popover used to freeze on its initial snapshot. The 250ms tick below
  // runs only while at least one active task exists, and feeds activeTasks()
  // a fresh array reference each tick so the @for re-evaluates the
  // template bindings (progress bar width, MB counter).
  private readonly tick = signal(0)
  private readonly hasActive = computed(() => this.activeTasksRaw().length > 0)
  protected readonly activeTasks = computed<FileTask[]>(() => {
    this.tick()
    return [...this.activeTasksRaw()]
  })

  constructor() {
    effect((onCleanup) => {
      if (!this.hasActive()) return
      const id = window.setInterval(() => this.tick.update((v) => v + 1), 250)
      onCleanup(() => window.clearInterval(id))
    })
  }

  protected readonly totalActive = computed(() => this.activeTasksRaw().length + this.syncCount())
  protected readonly totalDone = computed(() => this.endedTasks().filter((t) => t.status === FileTaskStatus.SUCCESS).length)
  protected readonly totalError = computed(() => this.endedTasks().filter((t) => t.status === FileTaskStatus.ERROR).length)

  protected readonly pillKind = computed<'active' | 'done' | null>(() => {
    if (this.totalActive() > 0) return 'active'
    if (this.totalDone() > 0) return 'done'
    return null
  })

  protected readonly pillColor = computed(() => {
    if (this.totalError() > 0) return 'rose' as const
    if (this.totalActive() > 0) return 'amber' as const
    return 'green' as const
  })

  @HostListener('document:click', ['$event'])
  onDocumentClick(ev: MouseEvent): void {
    if (!this.open()) return
    if (!this.host.nativeElement.contains(ev.target as Node)) {
      this.open.set(false)
    }
  }

  @HostListener('window:keydown.escape')
  onEscape(): void {
    this.open.set(false)
  }

  protected toggle(): void {
    if (this.pillKind() === null) return
    this.open.update((v) => !v)
  }

  protected progress(task: FileTask): number {
    const size = task.props.size
    const total = task.props.totalSize
    if (!total) return 0
    return Math.min(100, Math.round(((size ?? 0) / total) * 100))
  }

  protected operationLabel(op: FILE_OPERATION): string {
    switch (op) {
      case FILE_OPERATION.COPY:
        return 'Copy'
      case FILE_OPERATION.MOVE:
        return 'Move'
      case FILE_OPERATION.DOWNLOAD:
        return 'Download'
      case FILE_OPERATION.DELETE:
        return 'Delete'
      case FILE_OPERATION.COMPRESS:
        return 'Compress'
      case FILE_OPERATION.DECOMPRESS:
        return 'Decompress'
      case FILE_OPERATION.MAKE:
        return 'Create'
      case FILE_OPERATION.UPLOAD:
        return 'Upload'
      default:
        return 'Transfer'
    }
  }

  protected clearDone(): void {
    this.store.filesEndedTasks.next([])
  }

  // Expose enum for the template.
  protected readonly FileTaskStatus = FileTaskStatus
}
