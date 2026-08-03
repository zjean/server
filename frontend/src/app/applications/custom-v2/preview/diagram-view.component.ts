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
  format?: string
  filename?: string
  data?: string
  message?: { intent?: string }
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

  protected readonly conflict = signal<{ theirEtag: string; theirXml: string } | null>(null)

  private etag = ''
  private editorOrigin = '__unset__'
  private isWritable = false
  private pendingXml = ''
  private saving = false
  private queuedXml: string | null = null
  // While a conflict dialog is open we suppress backend saves (they would just
  // 409 again). We still want to use the user's latest canvas xml when they
  // pick "Keep mine", so we track the most recent xml the editor handed us.
  private latestXmlWhileConflicted: string | null = null
  private conflictRefreshing = false
  // Host-side Print path. Native File>Print and Ctrl+P inside the iframe also
  // work now that the parent serves COOP `same-origin-allow-popups` instead of
  // `same-origin` (see backend/src/app.bootstrap.ts) — drawio's window.open
  // popup stays in the parent BCG and can be written to from the iframe. We
  // keep this host-side path as a discoverable toolbar entry point that mirrors
  // Share / Download.
  private printWindow: Window | null = null

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
          const src = `${res.editorUrl}?embed=1&spin=1&proto=json&autosave=1&keepmodified=1&dark=1`
          this.iframeSrc.set(this.sanitizer.bypassSecurityTrustResourceUrl(src))
          this.loading.set(false)
        },
        error: () => {
          this.errorMessage.set('Failed to load diagram.')
          this.loading.set(false)
        }
      })
  }

  // Fires only when the parent document has focus — keydown events inside a
  // cross-origin iframe never bubble out. So Ctrl+P here covers the cases
  // where the user is interacting with our chrome, not drawio's canvas. The
  // canvas-focused case is unfixable from the host (see configure handler).
  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const isPrintCombo = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.key === 'p' || event.key === 'P')
    if (!isPrintCombo) return
    if (!this.iframeSrc()) return
    event.preventDefault()
    event.stopPropagation()
    this.requestPrint()
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
        // exportProtocol:true makes drawio route UI-triggered exports (File >
        // Export As > PDF/PNG/…) through postMessage. Without it, drawio tries
        // a popup → form-POST to convert.diagrams.net/node/export, which loads
        // a blank tab in our iframe-embedded context and never produces a
        // download. See drawio embed-mode docs (UI-triggered exports section).
        this.postToEditor({ action: 'load', xml: this.pendingXml, exportProtocol: true })
        break
      case 'save':
      case 'autosave':
        if (data.xml != null) this.saveXml(data.xml)
        break
      case 'export':
        if (data.message?.intent === 'print') this.completePrint(data)
        else this.downloadExport(data)
        break
      case 'exit':
        this.closeRequested.emit()
        break
    }
  }

  private downloadExport(data: DrawioEvent): void {
    if (!data.data) return
    const a = document.createElement('a')
    a.href = data.data
    a.download = data.filename ?? this.deriveExportFilename(data.format)
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  // Public so the file-detail toolbar can trigger it via viewChild ref.
  // Must run synchronously from a user-click handler — see body.
  requestPrint(): void {
    // window.open MUST run synchronously inside the click handler — otherwise
    // we lose the transient user-activation token and Firefox blocks the popup.
    // We open about:blank now (no URL → same-origin with parent), fill it once
    // drawio echoes the SVG back via the export postMessage protocol.
    const w = window.open('', '_blank')
    if (!w) return
    if (this.printWindow && !this.printWindow.closed) this.printWindow.close()
    this.printWindow = w
    // raw-colour-ok: this HTML is a separate print document, not app DOM. It
    // must not inherit the app theme — a diagram printed on a dark ground
    // wastes ink and loses stroke contrast on paper.
    try {
      w.document.open()
      w.document.write(
        '<!doctype html><meta charset="utf-8"><title>Print</title><body style="margin:0;font:14px/1.4 system-ui;display:flex;align-items:center;justify-content:center;height:100vh;color:#666">Preparing print preview…</body>'
      )
      w.document.close()
    } catch {
      // Some browsers throw before navigation completes — ignore, we'll write again.
    }
    this.postToEditor({ action: 'export', format: 'svg', asText: true, intent: 'print' })
  }

  private completePrint(data: DrawioEvent): void {
    const w = this.printWindow
    this.printWindow = null
    if (!w || w.closed) return
    const svg = data.data ?? ''
    if (!svg) {
      try {
        w.close()
      } catch {
        /* noop */
      }
      return
    }
    // Inline the SVG so the browser can vectorise it at print DPI. We wrap it
    // in print-friendly CSS that fits one page and triggers print() after the
    // SVG has laid out (rAF gives layout a tick to settle).
    // raw-colour-ok: the print document again — see printWindow above.
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${this.escapeHtml(this.deriveBaseName())}</title>
<style>
  html, body { margin: 0; padding: 0; }
  body { display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #fff; }
  svg { max-width: 100%; max-height: 100vh; height: auto; width: auto; }
  @media print {
    body { min-height: auto; }
    svg { max-height: none; }
  }
</style></head><body>${svg}<script>
  window.addEventListener('load', function () {
    requestAnimationFrame(function () { requestAnimationFrame(function () { window.focus(); window.print(); }); });
  });
  window.addEventListener('afterprint', function () { window.close(); });
</script></body></html>`
    try {
      w.document.open()
      w.document.write(html)
      w.document.close()
    } catch {
      try {
        w.close()
      } catch {
        /* noop */
      }
    }
  }

  private escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
  }

  private deriveBaseName(): string {
    return (
      this.path
        .split('/')
        .pop()
        ?.replace(/\.drawio$/i, '') || 'diagram'
    )
  }

  private deriveExportFilename(format: string | undefined): string {
    return `${this.deriveBaseName()}.${format ?? 'bin'}`
  }

  private postToEditor(msg: unknown): void {
    const frame = this.editorFrame()?.nativeElement
    frame?.contentWindow?.postMessage(JSON.stringify(msg), this.editorOrigin)
  }

  private saveXml(xml: string): void {
    if (!this.isWritable) return
    if (this.conflict() !== null) {
      // Dialog is open. Don't touch the backend — just remember the latest
      // canvas xml so "Keep mine" applies to what the user can actually see.
      this.latestXmlWhileConflicted = xml
      return
    }
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
            this.latestXmlWhileConflicted = xml
            this.recoverFromConflict()
            return
          }
          this.postToEditor({ action: 'status', message: 'Save failed.' })
        }
      })
  }

  // On 409 we ask the server for its current baseline and then surface an
  // explicit Keep-mine / Discard-mine / Cancel choice. Half-honouring optimistic
  // concurrency — telling the loser they lost without giving them a real choice
  // — is the bug: a silent baseline refresh would let the next save overwrite
  // the other party's edits without the user knowing it happened.
  private recoverFromConflict(): void {
    if (this.conflictRefreshing || this.conflict() !== null) return
    this.conflictRefreshing = true
    this.http
      .get<LoadResponse>('/api/diagrams/load', { params: { path: this.path } })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (fresh) => {
          this.conflictRefreshing = false
          this.conflict.set({ theirEtag: fresh.etag, theirXml: fresh.xml })
        },
        error: () => {
          this.conflictRefreshing = false
          this.postToEditor({
            action: 'status',
            message: 'File was modified by someone else and the refresh failed — reload to continue.'
          })
        }
      })
  }

  protected keepMine(): void {
    const c = this.conflict()
    if (!c) return
    const xml = this.latestXmlWhileConflicted ?? this.pendingXml
    this.etag = c.theirEtag
    this.conflict.set(null)
    this.latestXmlWhileConflicted = null
    this.doSave(xml)
  }

  protected discardMine(): void {
    const c = this.conflict()
    if (!c) return
    this.etag = c.theirEtag
    this.pendingXml = c.theirXml
    this.conflict.set(null)
    this.latestXmlWhileConflicted = null
    this.postToEditor({ action: 'load', xml: c.theirXml })
  }

  protected cancelConflict(): void {
    if (!this.conflict()) return
    this.conflict.set(null)
    this.latestXmlWhileConflicted = null
    // Leave etag stale on purpose. The next save attempt will 409 again and the
    // dialog will reopen with whatever the canvas looks like at that point.
  }
}
