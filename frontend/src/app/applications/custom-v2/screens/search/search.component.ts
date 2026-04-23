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
import { isImageMime, mimeToGlyph } from '../../utils/mime-to-glyph'

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
    if (isImageMime(r.mime)) {
      this.router.navigate(['/', V2_PATH, V2_ROUTES.VIEWER], { queryParams: { path: r.path } }).catch(console.error)
      return
    }
    this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: { path: r.path } }).catch(console.error)
  }
}
