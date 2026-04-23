import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal, OnDestroy } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { ActivatedRoute, Router } from '@angular/router'
import { API_SPACES_BROWSE } from '@sync-in-server/backend/src/applications/spaces/constants/routes'
import { SPACE_ALIAS, SPACE_REPOSITORY } from '@sync-in-server/backend/src/applications/spaces/constants/spaces'
import { Subscription } from 'rxjs'
import { ToBytesPipe } from '../../../../common/pipes/to-bytes.pipe'
import { TimeAgoPipe } from '../../../../common/pipes/time-ago.pipe'
import { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { SpaceFiles } from '@sync-in-server/backend/src/applications/spaces/interfaces/space-files.interface'
import { ButtonComponent } from '../../components/button.component'
import { FileGlyphComponent } from '../../components/file-glyph.component'
import { IconButtonComponent } from '../../components/icon-button.component'
import { PillComponent } from '../../components/pill.component'
import { IconV2Component, IconV2Name } from '../../icons/icon-v2.component'
import { V2BreadcrumbService, BreadcrumbSegment } from '../../layout/breadcrumb.service'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'
import { mimeToGlyph } from '../../utils/mime-to-glyph'

type BrowserMode = 'list' | 'grid' | 'gallery'

interface BrowserViewOption {
  id: BrowserMode
  icon: IconV2Name
  title: string
  disabled: boolean
}

@Component({
  selector: 'app-v2-personal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './personal.component.html',
  styleUrl: './personal.component.scss',
  imports: [IconV2Component, FileGlyphComponent, ButtonComponent, IconButtonComponent, PillComponent, ToBytesPipe, TimeAgoPipe]
})
export class PersonalComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient)
  private readonly route = inject(ActivatedRoute)
  private readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  private urlSubscription: Subscription | null = null

  protected readonly mimeToGlyph = mimeToGlyph
  protected readonly files = signal<FileProps[]>([])
  protected readonly loading = signal(true)
  protected readonly errorMessage = signal<string | null>(null)
  protected readonly filter = signal('')
  protected readonly mode = signal<BrowserMode>('list')

  protected readonly pathSegments = toSignal(this.route.url, { initialValue: [] })

  protected readonly viewOptions: BrowserViewOption[] = [
    { id: 'list', icon: 'list', title: 'List', disabled: false },
    { id: 'grid', icon: 'grid', title: 'Grid — coming next', disabled: true },
    { id: 'gallery', icon: 'gallery', title: 'Gallery — coming next', disabled: true }
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
    if (this.viewOptions.find((o) => o.id === mode)?.disabled) return
    this.mode.set(mode)
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
    if (file.mime?.startsWith('image/')) {
      this.router.navigate(['/', V2_PATH, V2_ROUTES.VIEWER], { queryParams: { path: file.path } }).catch(console.error)
      return
    }
    this.router.navigate(['/spaces/files/personal/', ...file.path.split('/')], { queryParams: { select: file.name } }).catch(console.error)
  }

  protected onFilterInput(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value)
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
