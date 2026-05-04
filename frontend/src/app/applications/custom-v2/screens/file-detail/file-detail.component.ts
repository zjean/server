import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { ActivatedRoute, Router } from '@angular/router'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { API_FILES_OPERATION } from '@sync-in-server/backend/src/applications/files/constants/routes'
import { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { API_SPACES_BROWSE } from '@sync-in-server/backend/src/applications/spaces/constants/routes'
import { SpaceFiles } from '@sync-in-server/backend/src/applications/spaces/interfaces/space-files.interface'
import { encodeUrl } from '@sync-in-server/backend/src/common/shared'
import { ToBytesPipe } from '../../../../common/pipes/to-bytes.pipe'
import { TimeAgoPipe } from '../../../../common/pipes/time-ago.pipe'
import { ButtonComponent } from '../../components/button.component'
import { CommentsPanelComponent } from '../../components/comments-panel.component'
import { FileGlyphComponent } from '../../components/file-glyph.component'
import { IconButtonComponent } from '../../components/icon-button.component'
import { IconV2Component, IconV2Name } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'
import { isPreviewable } from '../../utils/classify-file'
import { isImageMime, isPdfMime, mimeToGlyph } from '../../utils/mime-to-glyph'

type InspectorTab = 'info' | 'comment' | 'activity' | 'share'

interface TabDef {
  id: InspectorTab
  label: string
  icon: IconV2Name
}

@Component({
  selector: 'app-v2-file-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './file-detail.component.html',
  styleUrl: './file-detail.component.scss',
  imports: [
    IconV2Component,
    IconButtonComponent,
    FileGlyphComponent,
    ButtonComponent,
    CommentsPanelComponent,
    ToBytesPipe,
    TimeAgoPipe,
    L10nTranslateDirective,
    L10nTranslatePipe
  ]
})
export class FileDetailComponent implements OnInit {
  private readonly http = inject(HttpClient)
  private readonly route = inject(ActivatedRoute)
  private readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  private readonly destroyRef = inject(DestroyRef)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  protected readonly mimeToGlyph = mimeToGlyph
  protected readonly file = signal<FileProps | null>(null)
  protected readonly currentPath = signal<string>('')
  protected readonly parentPath = signal<string>('')
  protected readonly siblings = signal<FileProps[]>([])
  protected readonly loading = signal(true)
  protected readonly errorMessage = signal<string | null>(null)
  protected readonly tab = signal<InspectorTab>('info')

  protected readonly tabs: TabDef[] = [
    { id: 'info', label: 'Info', icon: 'info' },
    { id: 'comment', label: 'Comments', icon: 'comment' },
    { id: 'activity', label: 'Activity', icon: 'activity' },
    { id: 'share', label: 'Sharing', icon: 'shareTree' }
  ]

  protected readonly glyphType = computed(() => {
    const f = this.file()
    if (!f) return 'default' as const
    return f.isDir ? 'folder' : mimeToGlyph(f.mime)
  })

  protected readonly previewUrl = computed(() => {
    const p = this.currentPath()
    return p ? `${API_FILES_OPERATION}/${encodeUrl(p)}` : ''
  })

  protected readonly currentIndex = computed(() => {
    const p = this.currentPath()
    const prefix = this.parentPath()
    const sibs = this.siblings()
    if (!p || !prefix) return -1
    return sibs.findIndex((s) => `${prefix}/${s.name}` === p)
  })

  protected readonly isImage = computed(() => isImageMime(this.file()?.mime))
  protected readonly isPdf = computed(() => isPdfMime(this.file()?.mime))

  ngOnInit(): void {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const path = params.get('path')
      if (!path) {
        this.errorMessage.set('No file path supplied.')
        this.loading.set(false)
        return
      }
      const tab = params.get('tab') as InspectorTab | null
      const tabRequested = !!(tab && this.tabs.some((t) => t.id === tab))
      if (tabRequested) this.tab.set(tab)
      this.loadFile(path, tabRequested)
    })
  }

  protected setTab(t: InspectorTab): void {
    this.tab.set(t)
  }

  protected onHasCommentsChange(has: boolean): void {
    const f = this.file()
    if (!f) return
    if (!!f.hasComments === has) return
    this.file.set({ ...f, hasComments: has })
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

  protected close(): void {
    if (window.history.length > 1) {
      window.history.back()
    } else {
      this.router.navigate(['/', V2_PATH, V2_ROUTES.RECENTS]).catch(console.error)
    }
  }

  protected downloadClassic(): void {
    const p = this.currentPath()
    if (!p) return
    window.open(`${API_FILES_OPERATION}/${encodeUrl(p)}`, '_blank')
  }

  private goTo(path: string): void {
    this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: { path }, replaceUrl: true }).catch(console.error)
  }

  private loadFile(path: string, tabRequested: boolean): void {
    this.loading.set(true)
    this.errorMessage.set(null)
    this.currentPath.set(path)

    const parts = path.split('/').filter(Boolean)
    if (parts.length < 2) {
      this.errorMessage.set('Invalid file path.')
      this.loading.set(false)
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
          if (!match) {
            this.errorMessage.set('File not found in parent folder.')
            this.file.set(null)
            this.loading.set(false)
            return
          }
          // If the user landed on /v2/file?path=foo without an explicit
          // tab and the file is renderable in the unified preview, send
          // them to the overlay instead. The page would otherwise just
          // show a no-preview / one-of-two-supported-types fallback,
          // which is silly when a richer surface exists. Comment / share /
          // activity links continue to land here because they pin a tab.
          if (!tabRequested && isPreviewable(match)) {
            this.router.navigate(['/', V2_PATH, V2_ROUTES.RECENTS], { queryParams: { preview: path }, replaceUrl: true }).catch(console.error)
            return
          }
          this.file.set(match)
          this.siblings.set(result.files.filter((f) => !f.isDir))
          this.loading.set(false)
          this.breadcrumbs.setBreadcrumbs([{ label: 'Personal', icon: 'folder', route: ['/', V2_PATH, V2_ROUTES.PERSONAL] }, { label: match.name }])
        },
        error: (e: HttpErrorResponse) => {
          this.errorMessage.set(e.status === 403 ? 'You do not have access to this file.' : 'Failed to load file.')
          this.loading.set(false)
        }
      })
  }
}
