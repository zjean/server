import { HttpClient } from '@angular/common/http'
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  HostListener,
  inject,
  input,
  model,
  OnInit,
  signal,
  viewChild
} from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { FaIconComponent } from '@fortawesome/angular-fontawesome'
import { faLock } from '@fortawesome/free-solid-svg-icons'
import { L10nTranslateDirective } from 'angular-l10n'
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser'
import { LayoutService } from '../../../../layout/layout.service'
import { FileModel } from '../../models/file.model'

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

const READONLY_BAR_HEIGHT = 36

@Component({
  selector: 'app-files-viewer-diagram',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FaIconComponent, L10nTranslateDirective],
  templateUrl: './files-viewer-diagram.component.html',
  styleUrl: './files-viewer-diagram.component.scss'
})
export class FilesViewerDiagramComponent implements OnInit {
  file = input.required<FileModel>()
  currentHeight = input.required<number>()
  isReadonly = model.required<boolean>()

  private readonly http = inject(HttpClient)
  private readonly sanitizer = inject(DomSanitizer)
  private readonly destroyRef = inject(DestroyRef)
  private readonly layout = inject(LayoutService)
  private readonly editorFrame = viewChild<ElementRef<HTMLIFrameElement>>('editorFrame')

  protected readonly faLock = faLock
  protected readonly iframeSrc = signal<SafeResourceUrl | null>(null)
  protected readonly iframeHeight = computed(() => (this.isReadonly() ? this.currentHeight() - READONLY_BAR_HEIGHT : this.currentHeight()))

  private editorOrigin = '__unset__'
  private isWritable = false
  private pendingXml = ''
  private etag = ''
  private saving = false
  private queuedXml: string | null = null

  ngOnInit(): void {
    this.http
      .get<LoadResponse>('/api/diagrams/load', { params: { path: this.file().path } })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          try {
            const url = new URL(res.editorUrl)
            if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid scheme')
            this.editorOrigin = url.origin
          } catch {
            this.layout.closeDialog()
            this.layout.sendNotification('error', 'Unable to open document', this.file().name)
            return
          }
          this.etag = res.etag
          this.isWritable = res.isWritable
          this.isReadonly.set(!res.isWritable)
          this.pendingXml = res.xml
          const noSave = !res.isWritable ? '&noSaveBtn=1' : ''
          const src = `${res.editorUrl}?embed=1&spin=1&proto=json${noSave}`
          this.iframeSrc.set(this.sanitizer.bypassSecurityTrustResourceUrl(src))
        },
        error: () => {
          this.layout.closeDialog()
          this.layout.sendNotification('error', 'Unable to open document', this.file().name)
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
        this.postToEditor({ action: 'load', xml: this.pendingXml, ...(!this.isWritable ? { readOnly: 1 } : {}) })
        break
      case 'save':
      case 'autosave':
        if (data.xml != null) this.saveXml(data.xml)
        break
      case 'exit':
        this.layout.closeDialog()
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
      .put<{ etag: string; mtime: number }>('/api/diagrams/save', { path: this.file().path, xml, etag: this.etag })
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
