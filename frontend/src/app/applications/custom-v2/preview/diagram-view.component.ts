import { HttpClient } from '@angular/common/http'
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  EventEmitter,
  HostListener,
  inject,
  Input,
  OnInit,
  Output,
  signal,
  viewChild
} from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'

interface DrawioEvent {
  event: string
  xml?: string
}

interface LoadResponse {
  xml: string
  etag: string
  mtime: number
  name: string
  isWritable: boolean
  editorUrl: string
}

@Component({
  selector: 'app-v2-preview-diagram-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './diagram-view.component.html',
  styleUrl: './diagram-view.component.scss',
  imports: [L10nTranslateDirective, L10nTranslatePipe]
})
export class DiagramViewComponent implements OnInit {
  @Input({ required: true }) path!: string
  @Output() readonly closeRequested = new EventEmitter<void>()

  private readonly http = inject(HttpClient)
  private readonly sanitizer = inject(DomSanitizer)
  private readonly destroyRef = inject(DestroyRef)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private readonly editorFrame = viewChild<ElementRef<HTMLIFrameElement>>('editorFrame')

  protected readonly loading = signal(true)
  protected readonly errorMessage = signal<string | null>(null)
  protected readonly iframeSrc = signal<SafeResourceUrl | null>(null)

  private etag = ''
  private editorOrigin = '__unset__'
  private isWritable = false
  private pendingXml = ''
  private saving = false
  private queuedXml: string | null = null

  ngOnInit(): void {
    this.http
      .get<LoadResponse>('/api/diagrams/load', { params: { path: this.path } })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          try {
            const url = new URL(res.editorUrl)
            if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid scheme')
            this.editorOrigin = url.origin
          } catch {
            this.errorMessage.set('Failed to load diagram.')
            this.loading.set(false)
            return
          }
          this.etag = res.etag
          this.isWritable = res.isWritable
          this.pendingXml = res.xml
          const src = `${res.editorUrl}?embed=1&spin=1&proto=json&autosave=1`
          this.iframeSrc.set(this.sanitizer.bypassSecurityTrustResourceUrl(src))
          this.loading.set(false)
        },
        error: () => {
          this.errorMessage.set('Failed to load diagram.')
          this.loading.set(false)
        }
      })
  }

  @HostListener('window:message', ['$event'])
  onMessage(event: MessageEvent): void {
    if (event.origin !== this.editorOrigin) return
    let data: DrawioEvent
    try {
      data = typeof event.data === 'string' ? JSON.parse(event.data) : (event.data as DrawioEvent)
    } catch {
      return
    }
    switch (data.event) {
      case 'init':
        this.postToEditor({ action: 'load', xml: this.pendingXml })
        break
      case 'save':
      case 'autosave':
        if (data.xml != null) this.saveXml(data.xml)
        break
      case 'exit':
        this.closeRequested.emit()
        break
    }
  }

  private postToEditor(msg: unknown): void {
    const frame = this.editorFrame()?.nativeElement
    frame?.contentWindow?.postMessage(JSON.stringify(msg), this.editorOrigin)
  }

  private saveXml(xml: string): void {
    if (!this.isWritable) return
    if (this.saving) {
      this.queuedXml = xml
      return
    }
    this.doSave(xml)
  }

  private doSave(xml: string): void {
    this.saving = true
    this.http
      .put<{ etag: string; mtime: number }>('/api/diagrams/save', { path: this.path, xml, etag: this.etag })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.etag = res.etag
          this.saving = false
          this.postToEditor({ action: 'status', message: '' })
          if (this.queuedXml !== null) {
            const queued = this.queuedXml
            this.queuedXml = null
            this.doSave(queued)
          }
        },
        error: (e) => {
          this.saving = false
          this.queuedXml = null
          if (e?.status === 409) {
            this.recoverFromConflict()
            return
          }
          this.postToEditor({ action: 'status', message: 'Save failed.' })
        }
      })
  }

  // On 409, refresh the in-memory etag + baseline from the server so the next
  // save can succeed without forcing a page reload (which would discard the
  // user's in-progress edits). Half-honouring optimistic concurrency — telling
  // the loser they lost without giving them a path forward — is the bug.
  private recoverFromConflict(): void {
    this.http
      .get<LoadResponse>('/api/diagrams/load', { params: { path: this.path } })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (fresh) => {
          this.etag = fresh.etag
          this.pendingXml = fresh.xml
          this.postToEditor({
            action: 'status',
            message: 'Another change landed. Save again to keep your edits, or reload to discard them.'
          })
        },
        error: () => {
          this.postToEditor({
            action: 'status',
            message: 'File was modified by someone else and the refresh failed — reload to continue.'
          })
        }
      })
  }
}
