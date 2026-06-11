import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, inject, OnInit, signal, viewChild } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { ActivatedRoute, Router } from '@angular/router'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { FileContentModel } from '../../../files/models/file-content.model'
import { FilesService } from '../../../files/services/files.service'
import { ButtonComponent } from '../../components/button.component'
import { EmptyStateComponent } from '../../components/empty-state.component'
import { FileGlyphComponent } from '../../components/file-glyph.component'
import { IconV2Component } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'
import { mimeToGlyph } from '../../utils/mime-to-glyph'

const MIN_QUERY = 2
const LIMIT = 100

@Component({
  selector: 'app-v2-search',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './search.component.html',
  styleUrl: './search.component.scss',
  imports: [IconV2Component, FileGlyphComponent, ButtonComponent, EmptyStateComponent, L10nTranslateDirective, L10nTranslatePipe]
})
export class SearchComponent implements OnInit {
  private readonly filesService = inject(FilesService)
  private readonly router = inject(Router)
  private readonly route = inject(ActivatedRoute)
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
    // Seed from `?q=` so the top-bar's global search input can hand a query
    // off here without losing it. We subscribe rather than read once so the
    // user can paste a different query into the URL bar mid-session.
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const q = (params.get('q') ?? '').trim()
      if (!q || q === this.query()) return
      this.query.set(q)
      const el = this.input()?.nativeElement
      if (el) el.value = q
      this.onSubmit()
    })
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
    const fullPath = `${r.path}/${r.name}`
    this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: { path: fullPath } }).catch(console.error)
  }

  // Middle-click on a search result → new tab with file-detail.
  protected onResultAuxClick(event: MouseEvent, r: FileContentModel): void {
    if (event.button !== 1) return
    event.preventDefault()
    if (typeof window !== 'undefined') {
      window.open(`/#/${V2_PATH}/${V2_ROUTES.FILE}?path=${encodeURIComponent(`${r.path}/${r.name}`)}`, '_blank', 'noopener')
    }
  }
}
