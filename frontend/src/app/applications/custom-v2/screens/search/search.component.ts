import { HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, OnInit, signal, viewChild } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { ActivatedRoute, Router } from '@angular/router'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe, L10nTranslationService } from 'angular-l10n'
import { TimeAgoPipe } from '../../../../common/pipes/time-ago.pipe'
import { FileContentModel } from '../../../files/models/file-content.model'
import { FilesService } from '../../../files/services/files.service'
import { ButtonComponent } from '../../components/button.component'
import { ContextMenuAnchor, ContextMenuComponent, ContextMenuEntry } from '../../components/context-menu.component'
import { EmptyPanelComponent } from '../../components/empty-panel.component'
import { FileGlyphComponent, FileGlyphType } from '../../components/file-glyph.component'
import { IconButtonComponent } from '../../components/icon-button.component'
import { InputComponent } from '../../components/input.component'
import { SegmentedComponent, SegmentedOption } from '../../components/segmented.component'
import { SkeletonComponent } from '../../components/skeleton.component'
import { IconV2Component } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { SpacesService } from '../../../spaces/services/spaces.service'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'
import { mimeToGlyph } from '../../utils/mime-to-glyph'
import {
  applyFacets,
  groupBySpace,
  highlight,
  isSharesKey,
  markSegments,
  Segment,
  spaceLabel,
  TimeFacet,
  typeFacets,
  TypeFacet
} from './search-results'

const MIN_QUERY = 2
const LIMIT = 100
/** Two, because the design's row shows a snippet, not a transcript. */
const MAX_SNIPPETS = 1

type Scope = 'name' | 'content'

/** Settled by the server's own answer — see `contentIndexing` below. */
type Indexing = 'unknown' | 'available' | 'unavailable'

const TYPE_LABELS: Record<FileGlyphType, string> = {
  image: 'Images',
  video: 'Videos',
  audio: 'Audio',
  doc: 'Documents',
  sheet: 'Spreadsheets',
  deck: 'Presentations',
  pdf: 'PDFs',
  code: 'Code',
  archive: 'Archives',
  folder: 'Folders',
  default: 'Other files'
}

const TIME_LABELS: Record<TimeFacet, string> = {
  any: 'Any time',
  today: 'Today',
  week: 'Last 7 days',
  month: 'Last 30 days'
}

@Component({
  selector: 'app-v2-search',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './search.component.html',
  styleUrl: './search.component.scss',
  imports: [
    ButtonComponent,
    ContextMenuComponent,
    EmptyPanelComponent,
    FileGlyphComponent,
    IconButtonComponent,
    IconV2Component,
    InputComponent,
    SegmentedComponent,
    SkeletonComponent,
    TimeAgoPipe,
    L10nTranslateDirective,
    L10nTranslatePipe
  ]
})
export class SearchComponent implements OnInit {
  private readonly filesService = inject(FilesService)
  private readonly router = inject(Router)
  private readonly route = inject(ActivatedRoute)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  private readonly translation = inject(L10nTranslationService)
  private readonly spacesService = inject(SpacesService)
  private readonly destroyRef = inject(DestroyRef)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private readonly field = viewChild<InputComponent>('field')

  protected readonly mimeToGlyph = mimeToGlyph
  protected readonly minQuery = MIN_QUERY

  protected readonly query = signal('')
  /** The query the visible results actually belong to — what the copy quotes. */
  protected readonly lastQuery = signal('')
  protected readonly fullText = signal(false)
  protected readonly results = signal<FileContentModel[]>([])
  protected readonly loading = signal(false)
  protected readonly errorMessage = signal<string | null>(null)
  protected readonly searched = signal(false)
  protected readonly elapsedMs = signal(0)

  protected readonly type = signal<TypeFacet>('all')
  protected readonly time = signal<TimeFacet>('any')
  protected readonly menuAnchor = signal<ContextMenuAnchor | null>(null)
  protected readonly menuItems = signal<ContextMenuEntry[]>([])

  /**
   * Whether this server indexes file contents.
   *
   * `ServerConfig` does not carry it, so the client cannot know up front — the
   * endpoint 400s a full-text query when `files.contentIndexing.enabled` is off.
   * So we ask by doing, once: a 400 on a full-text search settles this as
   * `unavailable`, the scope falls back to names and the segmented stops offering
   * a choice that does not exist. Same shape as `VersionsService.availability`,
   * and for the same reason.
   */
  private readonly contentIndexing = signal<Indexing>('unknown')
  protected readonly contentIndexingEnabled = computed(() => this.contentIndexing() !== 'unavailable')

  // The user's spaces, for the group headers. The design's headers print space
  // NAMES ("PRODUCT TEAM"), and a result carries only the alias — which is a slug.
  // One list request per visit to this screen buys the difference; the alias is the
  // fallback, so a failed or slow list degrades to something still meaningful
  // rather than to blank.
  private readonly spaces = signal<{ alias: string; name: string }[]>([])

  protected readonly scopeOptions = computed<SegmentedOption<Scope>[]>(() => [
    { id: 'name', label: this.translation.translate('Name') },
    { id: 'content', label: this.translation.translate('Full-text') }
  ])

  /** The fetched page, narrowed by the two facets. */
  protected readonly visible = computed(() => applyFacets(this.results(), this.type(), this.time(), Date.now()))

  protected readonly groups = computed(() =>
    groupBySpace(this.visible(), (key) => spaceLabel(key, this.spaces())).map((g) => ({ ...g, isShares: isSharesKey(g.key) }))
  )

  protected readonly availableTypes = computed(() => typeFacets(this.results()))
  protected readonly hasFacets = computed(() => this.type() !== 'all' || this.time() !== 'any')

  protected readonly typeLabel = computed(() => (this.type() === 'all' ? 'All types' : TYPE_LABELS[this.type() as FileGlyphType]))
  protected readonly timeLabel = computed(() => TIME_LABELS[this.time()])

  /**
   * `5 results in 3 spaces · 41 ms`.
   *
   * Composed from three separately-pluralised fragments rather than one sentence
   * per plural combination — four keys would be needed for "1 result in 1 space"
   * to read correctly otherwise. The counts describe what is ON SCREEN, because
   * the facets narrow the fetched page rather than re-querying.
   */
  protected readonly metaLine = computed(() => {
    const rows = this.visible().length
    const spaces = this.groups().length
    const results = this.translation.translate(rows === 1 ? 'one_result' : 'nb_results', { nb: rows })
    const inSpaces = this.translation.translate(spaces === 1 ? 'v2_one_space' : 'v2_nb_spaces', { nb: spaces })
    return this.translation.translate('v2_search_meta', { results, spaces: inSpaces, ms: this.elapsedMs() })
  })

  ngOnInit(): void {
    this.breadcrumbs.setBreadcrumbs([{ label: 'Search', icon: 'search' }])
    // Seed from `?q=` so the top-bar's global search input can hand a query
    // off here without losing it. We subscribe rather than read once so the
    // user can paste a different query into the URL bar mid-session.
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const q = (params.get('q') ?? '').trim()
      if (!q || q === this.query()) return
      this.query.set(q)
      this.search()
    })
    this.spacesService
      .listSpaces()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (list) => this.spaces.set(list.map((s) => ({ alias: s.alias, name: s.name }))),
        error: () => undefined
      })
    queueMicrotask(() => this.field()?.focus())
  }

  protected onQueryInput(value: string): void {
    this.query.set(value)
    // A cleared field returns to the zero state rather than leaving the previous
    // result set stranded under an empty query.
    if (value.trim().length === 0) {
      this.results.set([])
      this.searched.set(false)
      this.errorMessage.set(null)
    }
  }

  protected setScope(scope: Scope): void {
    const next = scope === 'content'
    if (next === this.fullText()) return
    this.fullText.set(next)
    if (this.query().trim().length >= MIN_QUERY) this.search()
  }

  protected search(): void {
    const q = this.query().trim()
    if (q.length < MIN_QUERY) {
      this.results.set([])
      this.searched.set(false)
      return
    }
    this.loading.set(true)
    this.errorMessage.set(null)
    // Wall-clock from request to render, which is what the design's `41 ms` means
    // to a reader — not the server's own query time, which we are not told.
    const startedAt = Date.now()
    const wasFullText = this.fullText()
    this.filesService
      .search({ content: q, fullText: wasFullText, limit: LIMIT })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (items) => {
          if (wasFullText) this.contentIndexing.set('available')
          this.elapsedMs.set(Date.now() - startedAt)
          this.results.set(items)
          this.lastQuery.set(q)
          this.type.set('all')
          this.time.set('any')
          this.loading.set(false)
          this.searched.set(true)
        },
        error: (e: HttpErrorResponse) => {
          // A 400 on a full-text query is this server saying it does not index
          // contents. That is not an error to show — it is an answer, so record it,
          // drop back to names and re-run the same query.
          if (wasFullText && e.status === 400) {
            this.contentIndexing.set('unavailable')
            this.fullText.set(false)
            this.search()
            return
          }
          this.errorMessage.set(e.error?.message ?? 'Search failed.')
          this.results.set([])
          this.lastQuery.set(q)
          this.loading.set(false)
          this.searched.set(true)
        }
      })
  }

  protected clearFacets(): void {
    this.type.set('all')
    this.time.set('any')
  }

  protected nameSegments(r: FileContentModel): Segment[] {
    return highlight(r.name, this.lastQuery())
  }

  /**
   * The matched line, highlighted — or null when there is none.
   *
   * `FileContentModel.matches` is already populated by the backend for a full-text
   * search, so a snippet costs no request. One line, not all of them: the design's
   * row shows a snippet as evidence, and a row that grows to five lines stops being
   * a row.
   */
  protected snippet(r: FileContentModel): Segment[] | null {
    const first = r.matches?.slice(0, MAX_SNIPPETS)[0]
    if (!first) return null
    // The SERVER highlighted this one, so read its markers rather than re-matching
    // the query — it applied context and stemming we do not have.
    return markSegments(first)
  }

  protected openTypeMenu(anchor: HTMLElement): void {
    const items: ContextMenuEntry[] = [
      { id: 'all', label: 'All types', action: () => this.type.set('all') },
      ...this.availableTypes().map((t) => ({ id: t, label: TYPE_LABELS[t], action: () => this.type.set(t) }))
    ]
    this.openMenu(items, anchor)
  }

  protected openTimeMenu(anchor: HTMLElement): void {
    const items: ContextMenuEntry[] = (Object.keys(TIME_LABELS) as TimeFacet[]).map((t) => ({
      id: t,
      label: TIME_LABELS[t],
      action: () => this.time.set(t)
    }))
    this.openMenu(items, anchor)
  }

  protected openRowMenu(r: FileContentModel, ev: Event): void {
    // The row itself is the open affordance, so the menu must not also fire it.
    ev.stopPropagation()
    this.openMenu(
      [
        { id: 'open', label: 'Open', icon: 'eye', action: () => this.openResult(r) },
        { id: 'tab', label: 'Open in new tab', icon: 'globe', action: () => this.openInNewTab(r) },
        { id: 'folder', label: 'Show in folder', icon: 'folderOpen', action: () => this.revealFolder(r) }
      ],
      ev.currentTarget as HTMLElement
    )
  }

  // Anchored to the trigger's bottom-left edge with the design's 4px offset.
  private openMenu(items: ContextMenuEntry[], anchor: HTMLElement | null): void {
    const rect = anchor?.getBoundingClientRect()
    this.menuItems.set(items)
    this.menuAnchor.set(rect ? { x: rect.left, y: rect.bottom + 4 } : { x: 0, y: 0 })
  }

  protected closeMenu(): void {
    this.menuAnchor.set(null)
  }

  protected openResult(r: FileContentModel): void {
    // Backend FileContent.path is the parent directory; the filename lives in `name`.
    this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: { path: this.fullPath(r) } }).catch(console.error)
  }

  // Middle-click on a search result → new tab with file-detail.
  protected onResultAuxClick(event: MouseEvent, r: FileContentModel): void {
    if (event.button !== 1) return
    event.preventDefault()
    this.openInNewTab(r)
  }

  private openInNewTab(r: FileContentModel): void {
    if (typeof window === 'undefined') return
    window.open(`/#/${V2_PATH}/${V2_ROUTES.FILE}?path=${encodeURIComponent(this.fullPath(r))}`, '_blank', 'noopener')
  }

  /**
   * Opens the folder the result lives in.
   *
   * Only the two repositories with a folder browser can be reached: personal and a
   * space. `shares/…` has no per-alias browser in v2 (see favorites.component.ts
   * for the same limitation), so those fall back to opening the file — which is
   * the action the row already offers, and better than a route that 404s.
   */
  private revealFolder(r: FileContentModel): void {
    const parts = r.path.split('/').filter(Boolean)
    const [repository, alias, ...segments] = parts
    if (repository === 'files' && alias === 'personal') {
      this.router.navigate(['/', V2_PATH, V2_ROUTES.PERSONAL, ...segments]).catch(console.error)
      return
    }
    if (repository === 'files' && alias) {
      this.router.navigate(['/', V2_PATH, V2_ROUTES.SPACES, alias, ...segments]).catch(console.error)
      return
    }
    this.openResult(r)
  }

  private fullPath(r: FileContentModel): string {
    return `${r.path}/${r.name}`
  }
}
