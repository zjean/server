import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, inject, OnInit, signal, viewChild } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { Router } from '@angular/router'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { FileContentModel } from '../../../files/models/file-content.model'
import { FilesService } from '../../../files/services/files.service'
import { ButtonComponent } from '../../components/button.component'
import { FileGlyphComponent } from '../../components/file-glyph.component'
import { IconV2Component } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'
import { isImageMime, isPdfMime, mimeToGlyph } from '../../utils/mime-to-glyph'
import { openPreviewInNewTab } from '../../preview/open-preview'
import { PreviewOverlayService } from '../../preview/preview-overlay.service'

// Search results carry only `mime` (no FileProps), so the predicate is
// inlined here instead of using utils/classify-file's `isPreviewable(file)`.
function isPreviewableMime(mime: string | null | undefined): boolean {
  return isImageMime(mime) || isPdfMime(mime)
}

const MIN_QUERY = 2
const LIMIT = 100

@Component({
  selector: 'app-v2-search',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './search.component.html',
  styleUrl: './search.component.scss',
  imports: [IconV2Component, FileGlyphComponent, ButtonComponent, L10nTranslateDirective, L10nTranslatePipe]
})
export class SearchComponent implements OnInit {
  private readonly filesService = inject(FilesService)
  private readonly router = inject(Router)
  private readonly previewOverlay = inject(PreviewOverlayService)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  private readonly destroyRef = inject(DestroyRef)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private readonly input = viewChild<ElementRef<HTMLInputElement>>('queryInput')
  private activeSub?: { cancel?: () => void } | null = null

  protected readonly mimeToGlyph = mimeToGlyph
  protected readonly query = signal('')
  protected readonly fullText = signal(false)
  protected readonly results = signal<FileContentModel[]>([])
  protected readonly loading = signal(false)
  protected readonly errorMessage = signal<string | null>(null)
  protected readonly searched = signal(false)

  ngOnInit(): void {
    this.breadcrumbs.setBreadcrumbs([{ label: 'Search', icon: 'search' }])
    queueMicrotask(() => this.input()?.nativeElement.focus())
  }

  protected onQueryInput(ev: Event): void {
    this.query.set((ev.target as HTMLInputElement).value)
  }

  protected onSubmit(ev?: Event): void {
    ev?.preventDefault()
    const q = this.query().trim()
    if (q.length < MIN_QUERY) {
      this.results.set([])
      this.searched.set(false)
      return
    }
    this.loading.set(true)
    this.errorMessage.set(null)
    this.filesService
      .search({ content: q, fullText: this.fullText(), limit: LIMIT })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (items) => {
          this.results.set(items)
          this.loading.set(false)
          this.searched.set(true)
        },
        error: () => {
          this.errorMessage.set('Search failed.')
          this.loading.set(false)
          this.searched.set(true)
        }
      })
  }

  protected toggleFullText(): void {
    this.fullText.update((v) => !v)
    if (this.query().trim().length >= MIN_QUERY) this.onSubmit()
  }

  protected openResult(r: FileContentModel): void {
    // Backend FileContent.path is the parent directory; the filename lives in `name`.
    // Compose the full path the viewer/file-detail screens expect.
    const fullPath = `${r.path}/${r.name}`
    if (isPreviewableMime(r.mime)) {
      this.previewOverlay.open(fullPath)
      return
    }
    this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: { path: fullPath } }).catch(console.error)
  }

  // Middle-click on a search result → new tab with the chromeless preview
  // route.
  protected onResultAuxClick(event: MouseEvent, r: FileContentModel): void {
    if (event.button !== 1) return
    if (!isPreviewableMime(r.mime)) return
    event.preventDefault()
    openPreviewInNewTab(`${r.path}/${r.name}`)
  }
}
