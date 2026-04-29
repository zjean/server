import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser'
import { ActivatedRoute } from '@angular/router'
import { API_FILES_OPERATION } from '@sync-in-server/backend/src/applications/files/constants/routes'
import { encodeUrl } from '@sync-in-server/backend/src/common/shared'
import { assetsUrl } from '../../../files/files.constants'

// Chromeless wrapper around the bundled pdf.js viewer. Mounted as a top-level
// route (sibling of the v2 layout) so the iframe fills the whole tab — the
// caller is expected to open this in a new browser tab via window.open(_blank).
@Component({
  selector: 'app-v2-pdf-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (safeUrl(); as url) {
      <iframe class="pdf-viewer__frame" [src]="url"></iframe>
    } @else {
      <div class="pdf-viewer__error">No file path supplied.</div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        position: fixed;
        inset: 0;
        background: #1f1f1f;
      }
      .pdf-viewer__frame {
        width: 100%;
        height: 100%;
        border: 0;
        display: block;
      }
      .pdf-viewer__error {
        color: #fff;
        padding: 24px;
        font-family: system-ui, sans-serif;
      }
    `
  ]
})
export class PdfViewerComponent implements OnInit {
  private readonly route = inject(ActivatedRoute)
  private readonly sanitizer = inject(DomSanitizer)
  private readonly destroyRef = inject(DestroyRef)
  private readonly pdfjsViewerUrl = `${assetsUrl}/pdfjs/web/viewer.html?file=`

  protected readonly path = signal<string>('')
  protected readonly safeUrl = computed<SafeResourceUrl | null>(() => {
    const p = this.path()
    if (!p) return null
    return this.sanitizer.bypassSecurityTrustResourceUrl(`${this.pdfjsViewerUrl}${API_FILES_OPERATION}/${encodeUrl(p)}`)
  })

  ngOnInit(): void {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const path = params.get('path')
      if (!path) return
      this.path.set(path)
      const fileName = path.split('/').filter(Boolean).pop() ?? 'PDF'
      if (typeof document !== 'undefined') document.title = fileName
    })
  }
}
