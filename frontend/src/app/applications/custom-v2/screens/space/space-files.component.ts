import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, DestroyRef, ElementRef, inject, OnInit, signal, OnDestroy, ViewChild } from '@angular/core'
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop'
import { ActivatedRoute, Router } from '@angular/router'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { API_SPACES_BROWSE } from '@sync-in-server/backend/src/applications/spaces/constants/routes'
import { SPACE_REPOSITORY } from '@sync-in-server/backend/src/applications/spaces/constants/spaces'
import { combineLatest, Subscription } from 'rxjs'
import { pairwise } from 'rxjs/operators'
import { StoreService } from '../../../../store/store.service'
import { ToBytesPipe } from '../../../../common/pipes/to-bytes.pipe'
import { TimeAgoPipe } from '../../../../common/pipes/time-ago.pipe'
import { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { API_FILES_OPERATION } from '@sync-in-server/backend/src/applications/files/constants/routes'
import { SpaceFiles } from '@sync-in-server/backend/src/applications/spaces/interfaces/space-files.interface'
import { encodeUrl } from '@sync-in-server/backend/src/common/shared'
import { FileUpload } from '../../../files/interfaces/file-upload.interface'
import { FileModel } from '../../../files/models/file.model'
import { FilesService } from '../../../files/services/files.service'
import { FilesUploadService } from '../../../files/services/files-upload.service'
import { FILE_OPERATION } from '@sync-in-server/backend/src/applications/files/constants/operations'
import { buildFileModelStub, buildSpaceFilePath } from '../../utils/file-model-stub'
import { SpacesService } from '../../../spaces/services/spaces.service'
import { ConfirmDialogService } from '../../components/confirm-dialog.service'
import { LinkDialogService } from '../../components/link-dialog.service'
import { PromptDialogService } from '../../components/prompt-dialog.service'
import { ShareDialogService } from '../../components/share-dialog.service'
import { ToastService } from '../../components/toast.service'
import { TreePickerService } from '../../components/tree-picker.service'
import { ButtonComponent } from '../../components/button.component'
import { ContextMenuComponent, ContextMenuItem } from '../../components/context-menu.component'
import { DropZoneDirective } from '../../components/drop-zone.directive'
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

const VIEW_MODE_STORAGE_KEY = 'ui.space.viewMode'

function readStoredMode(): BrowserMode {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return 'list'
  const raw = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY)
  return raw === 'grid' || raw === 'gallery' || raw === 'list' ? raw : 'list'
}

@Component({
  selector: 'app-v2-space-files',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './space-files.component.html',
  styleUrl: './space-files.component.scss',
  imports: [
    IconV2Component,
    FileGlyphComponent,
    ButtonComponent,
    IconButtonComponent,
    PillComponent,
    ContextMenuComponent,
    DropZoneDirective,
    ToBytesPipe,
    TimeAgoPipe,
    L10nTranslateDirective,
    L10nTranslatePipe
  ]
})
export class SpaceFilesComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient)
  private readonly route = inject(ActivatedRoute)
  private readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  private readonly filesService = inject(FilesService)
  private readonly filesUpload = inject(FilesUploadService)
  private readonly spacesService = inject(SpacesService)
  private readonly confirmDialog = inject(ConfirmDialogService)
  private readonly treePicker = inject(TreePickerService)
  private readonly promptDialog = inject(PromptDialogService)
  private readonly linkDialog = inject(LinkDialogService)
  private readonly shareDialog = inject(ShareDialogService)
  private readonly toast = inject(ToastService)
  private readonly store = inject(StoreService)
  private readonly destroyRef = inject(DestroyRef)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private navSubscription: Subscription | null = null
  private spaceSubscription: Subscription | null = null
  private pendingDropRefresh = false
  private pendingDeleteRefresh = false
  private pendingCopyMoveRefresh = false

  @ViewChild('fileInput') private fileInput?: ElementRef<HTMLInputElement>

  protected readonly mimeToGlyph = mimeToGlyph
  protected readonly files = signal<FileProps[]>([])
  protected readonly loading = signal(true)
  protected readonly errorMessage = signal<string | null>(null)
  protected readonly filter = signal('')
  protected readonly mode = signal<BrowserMode>(readStoredMode())
  protected readonly menu = signal<{ file: FileProps; x: number; y: number } | null>(null)

  protected readonly alias = toSignal(this.route.params, { initialValue: {} as { alias?: string } })
  protected readonly pathSegments = toSignal(this.route.url, { initialValue: [] })
  protected readonly spaceName = signal<string>('')

  protected readonly viewOptions: BrowserViewOption[] = [
    { id: 'list', icon: 'list', title: 'List' },
    { id: 'grid', icon: 'grid', title: 'Grid' },
    { id: 'gallery', icon: 'gallery', title: 'Gallery' }
  ]

  protected readonly folderLabel = computed(() => {
    const segs = this.pathSegments()
    if (segs.length === 0) return this.spaceName() || this.currentAlias()
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
      { id: 'rename', label: 'Rename', icon: 'pencil', action: () => this.renameEntry(f) },
      { id: 'copy', label: 'Copy to…', icon: 'copy', action: () => this.copyOrMove(f, FILE_OPERATION.COPY) },
      { id: 'move', label: 'Move to…', icon: 'moveTo', action: () => this.copyOrMove(f, FILE_OPERATION.MOVE) },
      { id: 'get-link', label: 'Get link', icon: 'link', action: () => this.getLink(f) },
      { id: 'share', label: 'Share', icon: 'share', action: () => this.shareEntry(f) },
      {
        id: 'delete',
        label: 'Delete',
        icon: 'trash',
        kind: 'danger',
        action: () => this.confirmAndDelete(f)
      }
    ]
  })

  ngOnInit(): void {
    this.navSubscription = combineLatest([this.route.params, this.route.url]).subscribe(() => {
      this.syncBreadcrumbs()
      this.loadFiles()
    })
    this.store.filesActiveTasks.pipe(pairwise(), takeUntilDestroyed(this.destroyRef)).subscribe(([prev, curr]) => {
      if (prev.length > 0 && curr.length === 0) {
        if (this.pendingDropRefresh || this.pendingDeleteRefresh || this.pendingCopyMoveRefresh) {
          this.pendingDropRefresh = false
          this.pendingDeleteRefresh = false
          this.pendingCopyMoveRefresh = false
          this.refresh()
        }
      }
    })
  }

  ngOnDestroy(): void {
    this.navSubscription?.unsubscribe()
    this.spaceSubscription?.unsubscribe()
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
    const alias = this.currentAlias()
    if (!alias) return
    if (file.isDir) {
      const segs = this.pathSegments().map((s) => s.path)
      this.router.navigate(['/', V2_PATH, V2_ROUTES.SPACES, alias, ...segs, file.name]).catch(console.error)
      return
    }
    const segs = this.pathSegments().map((s) => s.path)
    const fullPath = [SPACE_REPOSITORY.FILES, alias, ...segs, file.name].join('/')
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

  protected async copyOrMove(file: FileProps, op: FILE_OPERATION.COPY | FILE_OPERATION.MOVE): Promise<void> {
    const isMove = op === FILE_OPERATION.MOVE
    const dst = await this.treePicker.open({
      title: isMove ? 'Move file' : 'Copy file',
      submitLabel: isMove ? 'Move here' : 'Copy here',
      disabledPath: this.currentUploadRoute()
    })
    if (!dst) return
    const stub = this.buildFileStub(file)
    this.pendingCopyMoveRefresh = true
    this.filesService.copyMove([stub], dst.path, op).catch(console.error)
    this.toast.success(isMove ? `Moving "${file.name}"…` : `Copying "${file.name}"…`)
  }

  private buildFileStub(file: FileProps): FileModel {
    const fullPath = buildSpaceFilePath(
      SPACE_REPOSITORY.FILES,
      this.currentAlias(),
      this.pathSegments().map((s) => s.path),
      file.name
    )
    return buildFileModelStub(file, fullPath)
  }

  protected async confirmAndDelete(file: FileProps): Promise<void> {
    const ok = await this.confirmDialog.open({
      title: 'Move to trash',
      message: 'v3_move_to_trash_one',
      messageParams: { name: file.name },
      confirmLabel: 'Move to trash',
      kind: 'danger'
    })
    if (!ok) return
    this.pendingDeleteRefresh = true
    this.filesService.delete([this.buildFileStub(file)])
    this.toast.success(`Moving "${file.name}" to trash…`)
  }

  protected downloadFile(file: FileProps): void {
    if (file.isDir) return
    const alias = this.currentAlias()
    const segs = this.pathSegments().map((s) => s.path)
    const fullPath = [SPACE_REPOSITORY.FILES, alias, ...segs, file.name].join('/')
    const url = `${API_FILES_OPERATION}/${encodeUrl(fullPath)}`
    if (typeof window !== 'undefined') {
      window.open(url, '_self')
    }
  }

  protected async getLink(file: FileProps): Promise<void> {
    const alias = this.currentAlias()
    const name = this.spaceName() || alias
    const segs = this.pathSegments().map((s) => s.path)
    const relativePath = [...segs, file.name].join('/')
    await this.linkDialog.open({
      file: {
        id: file.id,
        name: file.name,
        isDir: file.isDir,
        mime: file.mime,
        space: { alias, name, root: { alias, name } } as never
      },
      relativePath
    })
  }

  protected async shareEntry(file: FileProps): Promise<void> {
    const alias = this.currentAlias()
    const name = this.spaceName() || alias
    const segs = this.pathSegments().map((s) => s.path)
    const relativePath = [...segs, file.name].join('/')
    await this.shareDialog.open({
      file: {
        id: file.id,
        name: file.name,
        isDir: file.isDir,
        mime: file.mime,
        space: { alias, name, root: { alias, name } } as never
      },
      relativePath
    })
  }

  protected async renameEntry(file: FileProps): Promise<void> {
    const newName = await this.promptDialog.open({
      title: file.isDir ? 'Rename folder' : 'Rename file',
      placeholder: 'New name',
      submitLabel: 'Rename',
      initialValue: file.name,
      selectionRange: file.isDir ? 'all' : 'stem',
      validate: (v) => this.validateRenameName(v, file)
    })
    if (!newName || newName.trim() === file.name) return
    const trimmed = newName.trim()
    const stub = this.buildRenameStub(file)
    this.filesService.rename(stub, trimmed, false).subscribe({
      next: () => {
        this.toast.success(`Renamed to "${trimmed}"`)
        this.refresh()
      },
      error: (e: HttpErrorResponse) => {
        this.toast.error(e.error?.message ?? 'Rename failed')
      }
    })
  }

  private validateRenameName(v: string, file: FileProps): string | null {
    const trimmed = v.trim()
    if (!trimmed) return 'Name is required'
    if (trimmed.includes('/') || trimmed.includes('\\')) return 'Name cannot contain slashes'
    if (trimmed === '.' || trimmed === '..') return 'Invalid name'
    if (trimmed === file.name) return null
    const existing = this.files().some((f) => f.id !== file.id && f.name.toLowerCase() === trimmed.toLowerCase())
    if (existing) return 'A file or folder with this name already exists'
    return null
  }

  private buildRenameStub(file: FileProps): FileModel {
    return this.buildFileStub(file)
  }

  protected async newFolder(): Promise<void> {
    const name = await this.promptDialog.open({
      title: 'New folder',
      placeholder: 'Folder name',
      submitLabel: 'Create',
      validate: (v) => this.validateFolderName(v)
    })
    if (!name) return
    const dirPath = this.currentUploadRoute()
    this.filesService.make('directory', name.trim(), dirPath, true).subscribe({
      next: () => {
        this.toast.success(`Folder "${name.trim()}" created`)
        this.refresh()
      },
      error: (e: HttpErrorResponse) => {
        this.toast.error(e.error?.message ?? 'Folder creation failed')
      }
    })
  }

  private validateFolderName(v: string): string | null {
    const trimmed = v.trim()
    if (!trimmed) return 'Name is required'
    if (trimmed.includes('/') || trimmed.includes('\\')) return 'Name cannot contain slashes'
    if (trimmed === '.' || trimmed === '..') return 'Invalid name'
    const existing = this.files().some((f) => f.name.toLowerCase() === trimmed.toLowerCase())
    if (existing) return 'A file or folder with this name already exists'
    return null
  }

  protected triggerFilePicker(): void {
    const input = this.fileInput?.nativeElement
    if (!input) return
    input.value = ''
    input.click()
  }

  protected onFilePicked(event: Event): void {
    const input = event.target as HTMLInputElement
    const files = input.files
    if (!files || files.length === 0) return
    this.uploadFiles(Array.from(files))
  }

  protected onDropFiles(event: DragEvent): void {
    this.filesService.currentRoute = this.currentUploadRoute()
    this.pendingDropRefresh = true
    this.filesUpload.onDropFiles(event, [])
  }

  private uploadFiles(files: File[]): void {
    this.filesService.currentRoute = this.currentUploadRoute()
    this.filesUpload
      .addFiles(files as FileUpload[], false)
      .then(() => this.refresh())
      .catch((err) => {
        console.error(err)
        this.refresh()
      })
  }

  private currentUploadRoute(): string {
    const alias = this.currentAlias()
    const segs = this.pathSegments().map((s) => s.path)
    return [SPACE_REPOSITORY.FILES, alias, ...segs].join('/')
  }

  private currentAlias(): string {
    return this.alias().alias ?? ''
  }

  private loadFiles(): void {
    const alias = this.currentAlias()
    if (!alias) return
    this.loading.set(true)
    this.errorMessage.set(null)
    const segs = this.pathSegments().map((s) => s.path)
    const url = [API_SPACES_BROWSE, SPACE_REPOSITORY.FILES, alias, ...segs].join('/')
    this.http.get<SpaceFiles>(url).subscribe({
      next: (result) => {
        this.files.set(result.files)
        this.loading.set(false)
        if (!this.spaceName()) this.loadSpaceName(alias)
      },
      error: (e: HttpErrorResponse) => {
        this.files.set([])
        this.errorMessage.set(e.status === 404 ? 'Folder not found' : 'Failed to load folder')
        this.loading.set(false)
      }
    })
  }

  private loadSpaceName(alias: string): void {
    this.spaceSubscription?.unsubscribe()
    this.spaceSubscription = this.spacesService.listSpaces().subscribe({
      next: (spaces) => {
        const match = spaces.find((s) => s.alias === alias)
        if (match) {
          this.spaceName.set(match.name || alias)
          this.syncBreadcrumbs()
        }
      }
    })
  }

  private syncBreadcrumbs(): void {
    const alias = this.currentAlias()
    if (!alias) return
    const segs = this.pathSegments().map((s) => s.path)
    const spacesIndex: BreadcrumbSegment = {
      label: 'Spaces',
      icon: 'box',
      route: ['/', V2_PATH, V2_ROUTES.SPACES]
    }
    const root: BreadcrumbSegment = {
      label: this.spaceName() || alias,
      route: ['/', V2_PATH, V2_ROUTES.SPACES, alias]
    }
    const trail: BreadcrumbSegment[] = segs.map((seg, i) => ({
      label: seg,
      route: ['/', V2_PATH, V2_ROUTES.SPACES, alias, ...segs.slice(0, i + 1)]
    }))
    this.breadcrumbs.setBreadcrumbs([spacesIndex, root, ...trail])
  }
}
