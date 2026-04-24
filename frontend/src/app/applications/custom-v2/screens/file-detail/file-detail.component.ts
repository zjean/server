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
import { isAudioMime, isImageMime, isPdfMime, isTextViewerMime, isVideoMime, mimeToGlyph } from '../../utils/mime-to-glyph'
import { isOfficeExtension } from '../../utils/office'
import { API_ONLY_OFFICE_SETTINGS } from '@sync-in-server/backend/src/applications/files/modules/only-office/only-office.routes'
import type { OnlyOfficeReqDto } from '@sync-in-server/backend/src/applications/files/modules/only-office/only-office.dtos'
import { OnlyOfficeComponent } from '../../../files/components/utils/only-office.component'
import { buildFileModelStub } from '../../utils/file-model-stub'
import { ONLY_OFFICE_APP_LOCK } from '@sync-in-server/backend/src/applications/files/modules/only-office/only-office.constants'
import { FILE_MODE } from '@sync-in-server/backend/src/applications/files/constants/operations'
import type { FileModel } from '../../../files/models/file.model'
import { StoreService } from '../../../../store/store.service'
import { CodeEditor } from '@acrodata/code-editor'
import { FormsModule } from '@angular/forms'

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
    CodeEditor,
    FormsModule,
    OnlyOfficeComponent,
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
  private readonly store = inject(StoreService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  protected fileStub: FileModel | null = null

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
  protected readonly isVideo = computed(() => isVideoMime(this.file()?.mime))
  protected readonly isAudio = computed(() => isAudioMime(this.file()?.mime))
  protected readonly isText = computed(() => isTextViewerMime(this.file()?.mime))
  protected readonly isOffice = computed(() => isOfficeExtension(this.file()?.name))
  protected readonly textContent = signal<string>('')
  protected readonly textLoading = signal(false)
  protected readonly textError = signal<string | null>(null)

  protected readonly officeConfig = signal<OnlyOfficeReqDto | null>(null)
  protected readonly officeLoading = signal(false)
  protected readonly officeError = signal<string | null>(null)
  protected readonly officeDocId = computed(() => `v2-doc-${this.file()?.id ?? 'none'}`)

  // Active stage for PDFs: 'pdf' (default, iframe + PDF.js) or 'office' (OnlyOffice embed).
  // Only PDFs with isEditable semantics get the toggle; others just stay on 'pdf'.
  protected readonly pdfStage = signal<'pdf' | 'office'>('pdf')
  protected readonly canToggleToOffice = computed(() => {
    const f = this.file()
    if (!f || !this.isPdf()) return false
    // Assume OnlyOffice is available; failure degrades to "Preview not available".
    return true
  })
  protected readonly showOfficeEmbed = computed(() => this.isOffice() || (this.isPdf() && this.pdfStage() === 'office'))

  ngOnInit(): void {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const path = params.get('path')
      if (!path) {
        this.errorMessage.set('No file path supplied.')
        this.loading.set(false)
        return
      }
      const tab = params.get('tab') as InspectorTab | null
      if (tab && this.tabs.some((t) => t.id === tab)) {
        this.tab.set(tab)
      }
      this.loadFile(path)
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

  protected toggleToOffice(): void {
    this.pdfStage.set(this.pdfStage() === 'pdf' ? 'office' : 'pdf')
    if (this.pdfStage() === 'office' && !this.officeConfig()) {
      this.loadOfficeConfig()
    }
  }

  private loadOfficeConfig(): void {
    const p = this.currentPath()
    const f = this.file()
    if (!p || !f) return
    this.officeLoading.set(true)
    this.officeError.set(null)
    // Build a FileModel stub so classic lock handling in the viewer works
    // (FilesViewerOnlyOfficeComponent pattern — createLock/removeLock).
    this.fileStub = buildFileModelStub(f, p)
    this.http
      .get<OnlyOfficeReqDto>(`${API_ONLY_OFFICE_SETTINGS}/${p}`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (cfg) => {
          this.officeConfig.set(cfg ?? null)
          if (!cfg) this.officeError.set('OnlyOffice settings are missing.')
          else this.applyOfficeLock(cfg)
          this.officeLoading.set(false)
        },
        error: (e: HttpErrorResponse) => {
          this.officeError.set(
            e.status === 404 ? 'OnlyOffice is not available on this server.' : (e.error?.message ?? 'Failed to load OnlyOffice editor.')
          )
          this.officeConfig.set(null)
          this.officeLoading.set(false)
        }
      })
  }

  // Mirrors classic FilesViewerOnlyOfficeComponent.ngOnInit lock handling.
  // If the file is not read-only and no prior lock exists, mark an OnlyOffice
  // lock on the stub so subsequent classic calls (e.g. copyMove checks) see it.
  private applyOfficeLock(cfg: OnlyOfficeReqDto): void {
    const stub = this.fileStub
    if (!stub) return
    if (cfg.hasLock && !stub.lock) {
      stub.createLock(cfg.hasLock)
    }
    const isReadonly = cfg.config?.editorConfig?.mode === FILE_MODE.VIEW
    if (!isReadonly && !stub.lock) {
      const u = this.store.user.getValue()
      stub.createLock({
        owner: { login: u?.login ?? '', fullName: u?.fullName ?? '', email: u?.email ?? '' },
        app: ONLY_OFFICE_APP_LOCK,
        isExclusive: false
      })
    }
  }

  protected onOfficeSave(): void {
    this.fileStub?.updateHTimeAgo?.()
  }

  private loadTextContent(): void {
    const p = this.currentPath()
    if (!p) return
    this.textLoading.set(true)
    this.textError.set(null)
    this.http
      .get(`${API_FILES_OPERATION}/${encodeUrl(p)}`, { responseType: 'text' })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (body) => {
          this.textContent.set(body)
          this.textLoading.set(false)
        },
        error: (e: HttpErrorResponse) => {
          this.textError.set(e.status === 403 ? 'You do not have access to this file.' : 'Failed to load file contents.')
          this.textContent.set('')
          this.textLoading.set(false)
        }
      })
  }

  private goTo(path: string): void {
    this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: { path } }).catch(console.error)
  }

  private loadFile(path: string): void {
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
          this.file.set(match)
          this.siblings.set(result.files.filter((f) => !f.isDir))
          this.loading.set(false)
          this.breadcrumbs.setBreadcrumbs([{ label: 'Personal', icon: 'folder', route: ['/', V2_PATH, V2_ROUTES.PERSONAL] }, { label: match.name }])
          this.pdfStage.set('pdf')
          if (isTextViewerMime(match.mime)) this.loadTextContent()
          else {
            this.textContent.set('')
            this.textError.set(null)
          }
          if (isOfficeExtension(match.name)) this.loadOfficeConfig()
          else {
            this.officeConfig.set(null)
            this.officeError.set(null)
          }
        },
        error: (e: HttpErrorResponse) => {
          this.errorMessage.set(e.status === 403 ? 'You do not have access to this file.' : 'Failed to load file.')
          this.loading.set(false)
        }
      })
  }
}
