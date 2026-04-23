import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal, OnDestroy } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { ActivatedRoute, Router } from '@angular/router'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { API_SPACES_BROWSE } from '@sync-in-server/backend/src/applications/spaces/constants/routes'
import { SPACE_ALIAS, SPACE_REPOSITORY } from '@sync-in-server/backend/src/applications/spaces/constants/spaces'
import { Subscription } from 'rxjs'
import { ToBytesPipe } from '../../../../common/pipes/to-bytes.pipe'
import { TimeAgoPipe } from '../../../../common/pipes/time-ago.pipe'
import { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { API_FILES_OPERATION } from '@sync-in-server/backend/src/applications/files/constants/routes'
import { SpaceFiles } from '@sync-in-server/backend/src/applications/spaces/interfaces/space-files.interface'
import { encodeUrl } from '@sync-in-server/backend/src/common/shared'
import { ButtonComponent } from '../../components/button.component'
import { ContextMenuComponent, ContextMenuItem } from '../../components/context-menu.component'
import { FileGlyphComponent } from '../../components/file-glyph.component'
import { IconButtonComponent } from '../../components/icon-button.component'
import { PillComponent } from '../../components/pill.component'
import { IconV2Component, IconV2Name } from '../../icons/icon-v2.component'
import { V2BreadcrumbService, BreadcrumbSegment } from '../../layout/breadcrumb.service'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'
import { isImageMime, mimeToGlyph } from '../../utils/mime-to-glyph'

type BrowserMode = 'list' | 'grid' | 'gallery'

interface BrowserViewOption {
  id: BrowserMode
  icon: IconV2Name
  title: string
}

const VIEW_MODE_STORAGE_KEY = 'ui.personal.viewMode'

function readStoredMode(): BrowserMode {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return 'list'
  const raw = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY)
  return raw === 'grid' || raw === 'gallery' || raw === 'list' ? raw : 'list'
}

@Component({
  selector: 'app-v2-personal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './personal.component.html',
  styleUrl: './personal.component.scss',
  imports: [
    IconV2Component,
    FileGlyphComponent,
    ButtonComponent,
    IconButtonComponent,
    PillComponent,
    ContextMenuComponent,
    ToBytesPipe,
    TimeAgoPipe,
    L10nTranslateDirective,
    L10nTranslatePipe
  ]
})
export class PersonalComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient)
  private readonly route = inject(ActivatedRoute)
  private readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private urlSubscription: Subscription | null = null

  protected readonly mimeToGlyph = mimeToGlyph
  protected readonly files = signal<FileProps[]>([])
  protected readonly loading = signal(true)
  protected readonly errorMessage = signal<string | null>(null)
  protected readonly filter = signal('')
  protected readonly mode = signal<BrowserMode>(readStoredMode())
  protected readonly menu = signal<{ file: FileProps; x: number; y: number } | null>(null)

  protected readonly pathSegments = toSignal(this.route.url, { initialValue: [] })

  protected readonly viewOptions: BrowserViewOption[] = [
    { id: 'list', icon: 'list', title: 'List' },
    { id: 'grid', icon: 'grid', title: 'Grid' },
    { id: 'gallery', icon: 'gallery', title: 'Gallery' }
  ]

  protected readonly folderLabel = computed(() => {
    const segs = this.pathSegments()
    if (segs.length === 0) return 'Personal'
    return segs[segs.length - 1].path
  })

  protected readonly filteredFiles = computed(() => {
    const q = this.filter().toLowerCase().trim()
    const items = this.files()
    if (!q) return items
    return items.filter((f) => f.name.toLowerCase().includes(q))
  })

  protected readonly totalSize = computed(() => this.files().reduce((s, f) => s + (f.isDir ? 0 : f.size), 0))

  protected readonly menuItems = computed<ContextMenuItem[]>(() => {
    const entry = this.menu()
    if (!entry) return []
    const f = entry.file
    return [
      { id: 'open', label: 'Open', icon: 'eye', action: () => this.openEntry(f) },
      {
        id: 'download',
        label: 'Download',
        icon: 'download',
        disabled: f.isDir,
        disabledReason: f.isDir ? 'Coming soon' : undefined,
        action: () => this.downloadFile(f)
      },
      {
        id: 'share',
        label: 'Share',
        icon: 'share',
        disabled: true,
        disabledReason: 'Coming soon',
        action: () => undefined
      },
      {
        id: 'delete',
        label: 'Delete',
        icon: 'trash',
        kind: 'danger',
        disabled: true,
        disabledReason: 'Coming soon',
        action: () => undefined
      }
    ]
  })

  ngOnInit(): void {
    this.urlSubscription = this.route.url.subscribe(() => {
      this.syncBreadcrumbs()
      this.loadFiles()
    })
  }

  ngOnDestroy(): void {
    this.urlSubscription?.unsubscribe()
  }

  protected setMode(mode: BrowserMode): void {
    this.mode.set(mode)
    if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode)
    }
  }

  protected refresh(): void {
    this.loadFiles()
  }

  protected openEntry(file: FileProps): void {
    if (file.isDir) {
      const segs = this.pathSegments().map((s) => s.path)
      this.router.navigate(['/', V2_PATH, V2_ROUTES.PERSONAL, ...segs, file.name]).catch(console.error)
      return
    }
    const segs = this.pathSegments().map((s) => s.path)
    const fullPath = [SPACE_REPOSITORY.FILES, SPACE_ALIAS.PERSONAL, ...segs, file.name].join('/')
    if (isImageMime(file.mime)) {
      this.router.navigate(['/', V2_PATH, V2_ROUTES.VIEWER], { queryParams: { path: fullPath } }).catch(console.error)
      return
    }
    this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: { path: fullPath } }).catch(console.error)
  }

  protected onFilterInput(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value)
  }

  protected openRowMenu(event: MouseEvent, file: FileProps): void {
    event.stopPropagation()
    event.preventDefault()
    this.menu.set({ file, x: event.clientX, y: event.clientY })
  }

  protected closeMenu(): void {
    this.menu.set(null)
  }

  protected downloadFile(file: FileProps): void {
    if (file.isDir) return
    const segs = this.pathSegments().map((s) => s.path)
    const fullPath = [SPACE_REPOSITORY.FILES, SPACE_ALIAS.PERSONAL, ...segs, file.name].join('/')
    const url = `${API_FILES_OPERATION}/${encodeUrl(fullPath)}`
    if (typeof window !== 'undefined') {
      window.open(url, '_self')
    }
  }

  private loadFiles(): void {
    this.loading.set(true)
    this.errorMessage.set(null)
    const segs = this.pathSegments().map((s) => s.path)
    const url = [API_SPACES_BROWSE, SPACE_REPOSITORY.FILES, SPACE_ALIAS.PERSONAL, ...segs].join('/')
    this.http.get<SpaceFiles>(url).subscribe({
      next: (result) => {
        this.files.set(result.files)
        this.loading.set(false)
      },
      error: (e: HttpErrorResponse) => {
        this.files.set([])
        this.errorMessage.set(e.status === 404 ? 'Folder not found' : 'Failed to load folder')
        this.loading.set(false)
      }
    })
  }

  private syncBreadcrumbs(): void {
    const segs = this.pathSegments().map((s) => s.path)
    const root: BreadcrumbSegment = {
      label: 'Personal',
      icon: 'folder',
      route: ['/', V2_PATH, V2_ROUTES.PERSONAL]
    }
    const trail: BreadcrumbSegment[] = segs.map((seg, i) => ({
      label: seg,
      route: ['/', V2_PATH, V2_ROUTES.PERSONAL, ...segs.slice(0, i + 1)]
    }))
    this.breadcrumbs.setBreadcrumbs([root, ...trail])
  }
}
