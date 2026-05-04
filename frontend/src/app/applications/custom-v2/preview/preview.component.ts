import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  HostListener,
  inject,
  input,
  signal,
  viewChild
} from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser'
import { Router } from '@angular/router'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { API_FILES_OPERATION } from '@sync-in-server/backend/src/applications/files/constants/routes'
import { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { API_SPACES_BROWSE } from '@sync-in-server/backend/src/applications/spaces/constants/routes'
import { SpaceFiles } from '@sync-in-server/backend/src/applications/spaces/interfaces/space-files.interface'
import { encodeUrl } from '@sync-in-server/backend/src/common/shared'
import { ToBytesPipe } from '../../../common/pipes/to-bytes.pipe'
import { TimeAgoPipe } from '../../../common/pipes/time-ago.pipe'
import { CommentsPanelComponent } from '../components/comments-panel.component'
import { IconButtonComponent } from '../components/icon-button.component'
import { assetsUrl } from '../../files/files.constants'
import { IconV2Component } from '../icons/icon-v2.component'
import { isTextEditable } from '../utils/classify-file'
import { isAudioMime, isImageMime, isPdfMime, isTextViewerMime, isVideoMime } from '../utils/mime-to-glyph'
import { isOfficeExtension } from '../utils/office'
import { V2_PATH, V2_ROUTES } from '../v2.constants'
import { OfficeViewComponent } from './office-view.component'
import { PreviewOverlayService } from './preview-overlay.service'
import { TextCodeViewComponent } from './text-code-view.component'

export type PreviewMode = 'overlay' | 'standalone'

// Pick the sibling predicate based on the current file's media class so
// prev/next stays meaningful (image -> image, pdf -> pdf, office -> office,
// text -> text, video -> video, audio -> audio).
function sameClassPredicate(current: FileProps | undefined): (f: FileProps) => boolean {
  if (!current) return () => false
  if (isImageMime(current.mime)) return (f) => isImageMime(f.mime)
  if (isPdfMime(current.mime)) return (f) => isPdfMime(f.mime)
  if (isOfficeExtension(current.name)) return (f) => isOfficeExtension(f.name)
  if (isTextViewerMime(current.mime) && isTextEditable(current)) return (f) => isTextViewerMime(f.mime) && isTextEditable(f)
  if (isVideoMime(current.mime)) return (f) => isVideoMime(f.mime)
  if (isAudioMime(current.mime)) return (f) => isAudioMime(f.mime)
  return () => false
}

// Unified preview shell. Renders chrome (header, sibling nav, info pane,
// close) once and switches body content by mime type. Phases A-C wire
// image, pdf, and OnlyOffice; text/code arrives in D.
//
// Mounted in two contexts:
//  - overlay  — by PreviewOverlayComponent in layout-v2, fixed-position
//    backdrop on top of the underlying v2 route. Path comes from the
//    [path] input (overlay service drives it).
//  - standalone — at /v2/preview top-level route, chromeless full viewport
//    for new-tab opens via window.open / middle-click. Path comes from
//    the route's queryParam.
//
// Either way, the inner rendering is identical — only outer styling and
// the close() target differ.
@Component({
  selector: 'app-v2-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './preview.component.html',
  styleUrl: './preview.component.scss',
  imports: [
    IconV2Component,
    IconButtonComponent,
    OfficeViewComponent,
    TextCodeViewComponent,
    CommentsPanelComponent,
    ToBytesPipe,
    TimeAgoPipe,
    L10nTranslatePipe
  ]
})
export class PreviewComponent {
  private readonly http = inject(HttpClient)
  private readonly destroyRef = inject(DestroyRef)
  private readonly overlay = inject(PreviewOverlayService)
  private readonly router = inject(Router)
  private readonly sanitizer = inject(DomSanitizer)
  private readonly imageEl = viewChild<ElementRef<HTMLImageElement>>('imageEl')
  private readonly pdfjsViewerUrl = `${assetsUrl}/pdfjs/web/viewer.html?file=`
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  // Path is driven from the parent: PreviewOverlayComponent passes the
  // overlay's current path; the standalone route component passes the
  // queryParam. Either way, signal-based input — re-load triggers via
  // effect.
  readonly path = input.required<string>()
  readonly mode = input<PreviewMode>('overlay')
  // FileProps shortcut — saves a sibling fetch when the caller already
  // has the FileProps for this file (e.g. clicked from a list screen).
  readonly fileHint = input<FileProps | null>(null)

  protected readonly file = signal<FileProps | null>(null)
  protected readonly siblings = signal<FileProps[]>([])
  protected readonly parentPath = signal<string>('')
  protected readonly resolution = signal<string>('')
  protected readonly loadError = signal<string | null>(null)
  protected readonly infoOpen = signal(false)
  // Which sub-tab the info aside is showing. 'comments' is auto-disabled for
  // folders (the panel itself shows an empty state, but we never reach there).
  protected readonly infoTab = signal<'info' | 'comments'>('info')

  // For PDFs only: 'pdf' (default, pdf.js iframe) or 'office' (OnlyOffice
  // editor for editable PDFs). Office files always render as office; this
  // toggle is only relevant when the current file is a PDF.
  protected readonly pdfStage = signal<'pdf' | 'office'>('pdf')

  protected readonly currentIndex = computed(() => {
    const p = this.path()
    const prefix = this.parentPath()
    return this.siblings().findIndex((f) => `${prefix}/${f.name}` === p)
  })

  protected readonly fileName = computed(() => {
    const f = this.file()
    if (f) return f.name
    return this.path().split('/').filter(Boolean).pop() ?? ''
  })

  protected readonly imageUrl = computed(() => {
    const p = this.path()
    return p ? `${API_FILES_OPERATION}/${encodeUrl(p)}` : ''
  })

  // Resolves to e.g. `assets/pdfjs/web/viewer.html?file=/api/app/spaces/operation/<encoded path>`.
  // The relative `assets/...` resolves against `<base href="/">` (set in
  // index.html) so the iframe loads `/assets/pdfjs/web/viewer.html?file=...`.
  protected readonly pdfSafeUrl = computed<SafeResourceUrl | null>(() => {
    const p = this.path()
    if (!p || !this.isPdf()) return null
    return this.sanitizer.bypassSecurityTrustResourceUrl(`${this.pdfjsViewerUrl}${API_FILES_OPERATION}/${encodeUrl(p)}`)
  })

  protected readonly isImage = computed(() => isImageMime(this.file()?.mime))
  protected readonly isPdf = computed(() => isPdfMime(this.file()?.mime))
  // PDFs are also in ONLY_OFFICE_EXTENSIONS (OnlyOffice can edit them), but
  // for preview routing we want them to take the dedicated pdf.js branch by
  // default. The toolbar's pencil button (canToggleToOffice + pdfStage) is
  // the explicit opt-in to swap to OnlyOffice. Without this exclusion,
  // showOfficeEmbed() short-circuits the pdfSafeUrl branch and the user
  // never sees pdf.js even though the iframe URL is correctly built.
  protected readonly isOffice = computed(() => {
    const f = this.file()
    return !!f && !isPdfMime(f.mime) && isOfficeExtension(f.name)
  })
  protected readonly isVideo = computed(() => isVideoMime(this.file()?.mime))
  protected readonly isAudio = computed(() => isAudioMime(this.file()?.mime))
  // True for plain-text / source-code files we can open in CodeMirror.
  // Filters out office-by-extension and the unsupported list (binary stuff
  // that has a text-y mime but really shouldn't be edited as text).
  protected readonly isText = computed(() => {
    const f = this.file()
    return !!f && isTextViewerMime(f.mime) && isTextEditable(f)
  })

  // True when the body should render OnlyOffice — either the file itself
  // is an office doc, or it's a PDF that the user toggled into edit mode.
  protected readonly showOfficeEmbed = computed(() => this.isOffice() || (this.isPdf() && this.pdfStage() === 'office'))

  // PDF-only edit affordance — show a small toggle button when the user
  // could swap from the read-only pdf.js view to the OnlyOffice editor.
  // (The OfficeView itself surfaces "OnlyOffice not available" if the
  // server has no document server configured, so we don't pre-check here.)
  protected readonly canToggleToOffice = computed(() => !!this.file() && this.isPdf())

  // Comments tab is only meaningful for actual files. Folders use the
  // standard file detail screen for comments anyway; in the preview, we
  // hide the tab rather than show a "comments are file-only" empty state.
  protected readonly commentsAvailable = computed(() => {
    const f = this.file()
    return !!f && !f.isDir
  })

  constructor() {
    // Re-load whenever the input path changes. Covers in-overlay sibling
    // navigation (path mutates without component remounting) AND the
    // initial mount. Reset pdfStage and the info-tab on every navigation
    // so a previous file's editor toggle / comments tab doesn't leak in.
    effect(() => {
      const p = this.path()
      if (!p) return
      this.resolution.set('')
      this.loadError.set(null)
      this.pdfStage.set('pdf')
      this.infoTab.set('info')
      this.loadFile(p)
    })
  }

  protected setInfoTab(tab: 'info' | 'comments'): void {
    this.infoTab.set(tab)
  }

  @HostListener('window:keydown', ['$event'])
  onKey(ev: KeyboardEvent): void {
    if (ev.key === 'ArrowRight') {
      this.next()
      ev.preventDefault()
    } else if (ev.key === 'ArrowLeft') {
      this.previous()
      ev.preventDefault()
    } else if (ev.key === 'Escape') {
      this.close()
      ev.preventDefault()
    }
  }

  protected next(): void {
    const sibs = this.siblings()
    if (!sibs.length) return
    const idx = (this.currentIndex() + 1 + sibs.length) % sibs.length
    this.goTo(`${this.parentPath()}/${sibs[idx].name}`)
  }

  protected previous(): void {
    const sibs = this.siblings()
    if (!sibs.length) return
    const idx = (this.currentIndex() - 1 + sibs.length) % sibs.length
    this.goTo(`${this.parentPath()}/${sibs[idx].name}`)
  }

  protected fullscreen(): void {
    this.imageEl()?.nativeElement.requestFullscreen().catch(console.error)
  }

  protected toggleInfo(): void {
    this.infoOpen.update((v) => !v)
  }

  protected toggleToOffice(): void {
    this.pdfStage.update((s) => (s === 'pdf' ? 'office' : 'pdf'))
  }

  protected close(): void {
    if (this.mode() === 'overlay') {
      this.overlay.close()
      return
    }
    // Standalone-mode close: a new tab — best we can do is window.close,
    // which only works if we opened the tab ourselves (we did, via
    // window.open). If the user landed here directly, fall through to
    // history.back(); if that's empty (fresh tab), do nothing.
    if (typeof window !== 'undefined') {
      if (window.history.length > 1) window.history.back()
      else window.close()
    }
  }

  // Trigger a download of the current file via the spaces operation API.
  // Used by the no-preview fallback so unrenderable types still have an
  // affordance. _self target so the browser uses its native download flow.
  protected download(): void {
    const p = this.path()
    if (!p || typeof window === 'undefined') return
    window.open(`${API_FILES_OPERATION}/${encodeUrl(p)}`, '_self')
  }

  protected onImageLoad(): void {
    const img = this.imageEl()?.nativeElement
    if (img) this.resolution.set(`${img.naturalWidth} × ${img.naturalHeight}`)
    this.loadError.set(null)
  }

  protected onImageError(): void {
    this.loadError.set('Failed to load file.')
  }

  // Sibling nav inside the overlay updates the URL's preview= param via
  // the service. In standalone mode we navigate the standalone route with
  // replaceUrl so back-button doesn't accumulate one entry per sibling.
  private goTo(path: string): void {
    if (this.mode() === 'overlay') {
      this.overlay.open(path, null)
    } else {
      this.router.navigate(['/', V2_PATH, V2_ROUTES.PREVIEW], { queryParams: { path }, replaceUrl: true }).catch(console.error)
    }
  }

  private loadFile(path: string): void {
    // Apply hint immediately so the chrome header (filename) and sub-view
    // dispatch (mime) don't flash empty.
    const hint = this.fileHint()
    if (hint && `${hint.name}` && path.endsWith(`/${hint.name}`)) this.file.set(hint)

    const parts = path.split('/').filter(Boolean)
    if (parts.length < 2) {
      this.loadError.set('Invalid file path.')
      return
    }
    const parentPath = parts.slice(0, -1).join('/')
    const name = parts[parts.length - 1]
    this.parentPath.set(parentPath)

    this.http
      .get<SpaceFiles>(`${API_SPACES_BROWSE}/${parentPath}`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => {
          const match = result.files.find((f) => f.name === name)
          if (match) this.file.set(match)
          // Sibling list filtered to the same media class as the current
          // file so prev/next stays meaningful (image -> image, pdf -> pdf,
          // office -> office).
          const cls = sameClassPredicate(match)
          this.siblings.set(result.files.filter((f) => !f.isDir && cls(f)))
        },
        error: (e: HttpErrorResponse) => {
          // Single-file render still works, just lose prev/next.
          console.warn('v2 preview: could not list siblings', e)
          this.siblings.set([])
        }
      })
  }
}
