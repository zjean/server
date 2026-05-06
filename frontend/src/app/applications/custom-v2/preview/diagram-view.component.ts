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
  styleUrl: './diagram-view.component.scss'
})
export class DiagramViewComponent implements OnInit {
  @Input({ required: true }) path!: string
  @Output() readonly closeRequested = new EventEmitter<void>()

  private readonly http = inject(HttpClient)
  private readonly sanitizer = inject(DomSanitizer)
  private readonly destroyRef = inject(DestroyRef)
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
      .get<LoadResponse>(`/diagrams/load?path=${encodeURIComponent(this.path)}`)
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
          const src = `${res.editorUrl}?embed=1&spin=1&proto=json`
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
      .put<{ etag: string; mtime: number }>('/diagrams/save', { path: this.path, xml, etag: this.etag })
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
          const msg = e?.status === 409 ? 'File was modified by someone else — reload to continue.' : 'Save failed.'
          this.postToEditor({ action: 'status', message: msg })
        }
      })
  }
}
