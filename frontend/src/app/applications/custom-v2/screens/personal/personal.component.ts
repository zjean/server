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
  OnInit,
  signal,
  OnDestroy,
  ViewChild
} from '@angular/core'
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop'
import { ActivatedRoute, Router } from '@angular/router'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { API_SPACES_BROWSE } from '@sync-in-server/backend/src/applications/spaces/constants/routes'
import { SPACE_ALIAS, SPACE_REPOSITORY } from '@sync-in-server/backend/src/applications/spaces/constants/spaces'
import { Subscription } from 'rxjs'
import { filter } from 'rxjs/operators'
import { FileEvent } from '../../../files/interfaces/file-event.interface'
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
import { ConfirmDialogService } from '../../components/confirm-dialog.service'
import { LinkDialogService } from '../../components/link-dialog.service'
import { PromptDialogService } from '../../components/prompt-dialog.service'
import { ShareDialogService } from '../../components/share-dialog.service'
import { ToastService } from '../../components/toast.service'
import { TreePickerService } from '../../components/tree-picker.service'
import { ActionSheetComponent, ActionSheetEntry } from '../../components/action-sheet.component'
import { ButtonComponent } from '../../components/button.component'
import { CheckboxComponent } from '../../components/checkbox.component'
import { ContextMenuAnchor, ContextMenuComponent, ContextMenuEntry, ContextMenuItem } from '../../components/context-menu.component'
import { DropZoneDirective } from '../../components/drop-zone.directive'
import { FabComponent } from '../../components/fab.component'
import { FileGlyphComponent } from '../../components/file-glyph.component'
import { FileThumbComponent } from '../../components/file-thumb.component'
import { IconButtonComponent } from '../../components/icon-button.component'
import { PillComponent } from '../../components/pill.component'
import { TAR_GZ_EXTENSION } from '@sync-in-server/backend/src/applications/files/constants/compress'
import { IconV2Component, IconV2Name } from '../../icons/icon-v2.component'
import { V2BreadcrumbService, BreadcrumbSegment } from '../../layout/breadcrumb.service'
import { DockRailService, FILE_BROWSER_DOCK_TABS } from '../../layout/dock-rail.service'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'
import { mimeToGlyph } from '../../utils/mime-to-glyph'
import { validHttpSchemaRegexp } from '../../../../common/utils/regexp'
import { buildNewEntryMenu, buildNewEntrySheetItems, NewEntryId } from '../files/new-entry-menu'

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
    FileThumbComponent,
    ButtonComponent,
    CheckboxComponent,
    IconButtonComponent,
    PillComponent,
    ContextMenuComponent,
    DropZoneDirective,
    FabComponent,
    ActionSheetComponent,
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
  private readonly filesService = inject(FilesService)
  private readonly filesUpload = inject(FilesUploadService)
  private readonly confirmDialog = inject(ConfirmDialogService)
  private readonly treePicker = inject(TreePickerService)
  private readonly promptDialog = inject(PromptDialogService)
  private readonly linkDialog = inject(LinkDialogService)
  private readonly shareDialog = inject(ShareDialogService)
  private readonly toast = inject(ToastService)
  private readonly store = inject(StoreService)
  private readonly dockRail = inject(DockRailService)
  private readonly destroyRef = inject(DestroyRef)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private urlSubscription: Subscription | null = null

  @ViewChild('fileInput') private fileInput?: ElementRef<HTMLInputElement>
  @ViewChild('filterInput') private filterInput?: ElementRef<HTMLInputElement>

  // Platform-aware label for the filter shortcut hint. The kbd badge next
  // to the filter input promises ⌘F (or Ctrl-F on non-Mac); we deliver on
  // it via the keydown handler below.
  protected readonly filterShortcutLabel: string = (() => {
    if (typeof navigator === 'undefined') return 'Ctrl F'
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '') || /Mac/.test(navigator.userAgent || '')
    return isMac ? '⌘F' : 'Ctrl F'
  })()

  protected readonly mimeToGlyph = mimeToGlyph
  protected readonly FILE_OPERATION = FILE_OPERATION
  protected readonly files = signal<FileProps[]>([])
  protected readonly loading = signal(true)
  protected readonly errorMessage = signal<string | null>(null)
  protected readonly filter = signal('')
  protected readonly mode = signal<BrowserMode>(readStoredMode())
  protected readonly menu = signal<{ file: FileProps; x: number; y: number } | null>(null)
  // Mobile FAB-driven action sheet. Opens with a list of "create"
  // options (the same ones available in the desktop toolbar) and
  // dispatches by id when picked.
  protected readonly fabSheetOpen = signal(false)
  // Mirrors the desktop "+ New" menu (Folder/Text + the OnlyOffice trio
  // when enabled), then tacks on the FAB-only Download from URL and
  // Upload primitives.
  protected readonly fabSheetItems = computed<readonly ActionSheetEntry[]>(() => [
    ...buildNewEntrySheetItems({ onlyOfficeEnabled: this.store.server().fileEditors.onlyoffice }),
    { id: 'sep-fab', kind: 'divider' },
    { id: 'download-url', label: 'Download from URL', icon: 'globe' },
    { id: 'upload', label: 'Upload', icon: 'upload' }
  ])

  // Desktop "+ New" dropdown — anchored under the primary toolbar button.
  // Items come from buildNewEntryMenu so personal and space-files stay
  // in lockstep; the OnlyOffice trio is omitted when the editor is off.
  protected readonly newMenuOpen = signal(false)
  protected readonly newMenuAnchor = signal<ContextMenuAnchor | null>(null)
  protected readonly newMenuItems = computed<ContextMenuEntry[]>(() =>
    buildNewEntryMenu({
      onlyOfficeEnabled: this.store.server().fileEditors.onlyoffice,
      onSelect: (id) => this.dispatchNewEntry(id)
    })
  )

  protected readonly selection = signal<Set<number>>(new Set())
  private selectionAnchorId: number | null = null

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

  protected readonly selectedFiles = computed(() => {
    const ids = this.selection()
    if (ids.size === 0) return []
    return this.filteredFiles().filter((f) => ids.has(f.id))
  })
  protected readonly hasSelection = computed(() => this.selection().size > 0)
  protected readonly selectionCount = computed(() => this.selection().size)
  protected readonly selectionSize = computed(() => this.selectedFiles().reduce((s, f) => s + (f.isDir ? 0 : f.size), 0))
  protected readonly selectionHasShares = computed(() =>
    this.selectedFiles().some((f) => {
      const shares = (f as FileProps & { shares?: { id: number }[] }).shares
      return Array.isArray(shares) && shares.length > 0
    })
  )
  protected readonly selectAllState = computed<'checked' | 'unchecked' | 'indeterminate'>(() => {
    const total = this.filteredFiles().length
    const selected = this.selectedFiles().length
    if (selected === 0) return 'unchecked'
    if (selected === total) return 'checked'
    return 'indeterminate'
  })

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
      { id: 'comments', label: 'Comments', icon: 'comment', disabled: f.isDir, action: () => this.openComments(f) },
      {
        id: 'delete',
        label: 'Delete',
        icon: 'trash',
        kind: 'danger',
        action: () => this.confirmAndDelete(f)
      }
    ]
  })

  constructor() {
    effect(() => {
      // Drop selection entries for files that no longer exist in the current
      // folder (refresh after delete/move, folder nav, filter change).
      const ids = new Set(this.filteredFiles().map((f) => f.id))
      const current = this.selection()
      if (current.size === 0) return
      let changed = false
      const next = new Set<number>()
      current.forEach((id) => {
        if (ids.has(id)) {
          next.add(id)
        } else {
          changed = true
        }
      })
      if (changed) this.selection.set(next)
    })
    // Push the single-row selection into the dock context so the right
    // panel's Info / Comments tabs render against it. Multi-select or
    // empty-select clears the panel back to its empty state.
    effect(() => {
      const sel = this.selectedFiles()
      if (sel.length !== 1) {
        this.dockRail.currentSelected.set(null)
        return
      }
      const f = sel[0]
      const segs = this.pathSegments().map((s) => s.path)
      const path = [SPACE_REPOSITORY.FILES, SPACE_ALIAS.PERSONAL, ...segs, f.name].join('/')
      this.dockRail.currentSelected.set({
        id: f.id,
        name: f.name,
        path,
        mime: f.mime,
        size: f.size,
        isDir: f.isDir,
        mtime: f.mtime,
        ctime: f.ctime
      })
    })
  }

  ngOnInit(): void {
    this.dockRail.setTabs(FILE_BROWSER_DOCK_TABS)
    this.urlSubscription = this.route.url.subscribe(() => {
      this.syncBreadcrumbs()
      this.clearSelection()
      this.loadFiles()
    })
    // Refresh on each task affecting this folder, not just when the active queue
    // empties — a single hung upload (e.g. a backgrounded tab pausing requests)
    // can leave activeTasks > 0 forever, suppressing the UI feedback for every
    // upload that did succeed. Mirrors classic spaces-browser's filesOnEvent reload.
    this.store.filesOnEvent
      .pipe(
        filter((ev: FileEvent | null) => {
          if (!ev) return false
          const here = this.currentUploadRoute()
          return ev.filePath === here || ev.fileDstPath === here
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(() => this.refresh())
  }

  ngOnDestroy(): void {
    this.urlSubscription?.unsubscribe()
    this.dockRail.clear()
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

  @HostListener('window:keydown', ['$event'])
  protected onWindowKeydown(event: KeyboardEvent): void {
    // Cmd/Ctrl+F focuses the filter input, preempting the browser's
    // built-in Find dialog. Honored from anywhere on the screen — even
    // when focus is already in another input — because the kbd hint next
    // to the filter promises this and a stuck-elsewhere focus would
    // surprise the user.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      const el = this.filterInput?.nativeElement
      if (el) {
        event.preventDefault()
        el.focus()
        el.select()
        return
      }
    }
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
    if (event.key === 'Escape' && this.hasSelection()) {
      this.clearSelection()
      event.preventDefault()
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      this.selectAllFiltered()
      event.preventDefault()
      return
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && this.hasSelection()) {
      this.bulkDelete()
      event.preventDefault()
    }
  }

  protected isSelected(file: FileProps): boolean {
    return this.selection().has(file.id)
  }

  protected onRowClick(event: MouseEvent, file: FileProps): void {
    if (event.shiftKey && this.selectionAnchorId !== null) {
      this.selectRange(file)
      return
    }
    if (event.metaKey || event.ctrlKey) {
      this.toggleSelection(file)
      return
    }
    const sel = this.selection()
    // Re-clicking the single selected file opens it — otherwise a selection
    // would trap the user from opening a file without first hitting Escape.
    if (sel.size > 1 || (sel.size === 1 && !sel.has(file.id))) {
      this.selection.set(new Set([file.id]))
      this.selectionAnchorId = file.id
      return
    }
    this.openEntry(file)
  }

  protected toggleSelection(file: FileProps): void {
    this.selection.update((current) => {
      const next = new Set(current)
      if (next.has(file.id)) next.delete(file.id)
      else next.add(file.id)
      return next
    })
    this.selectionAnchorId = file.id
  }

  protected toggleSelectAll(): void {
    if (this.selectAllState() === 'checked') this.clearSelection()
    else this.selectAllFiltered()
  }

  protected clearSelection(): void {
    if (!this.hasSelection()) return
    this.selection.set(new Set())
    this.selectionAnchorId = null
  }

  private selectAllFiltered(): void {
    const ids = this.filteredFiles().map((f) => f.id)
    this.selection.set(new Set(ids))
    this.selectionAnchorId = ids[ids.length - 1] ?? null
  }

  private selectRange(target: FileProps): void {
    const items = this.filteredFiles()
    const anchorIdx = items.findIndex((f) => f.id === this.selectionAnchorId)
    const targetIdx = items.findIndex((f) => f.id === target.id)
    if (anchorIdx === -1 || targetIdx === -1) {
      this.selection.set(new Set([target.id]))
      this.selectionAnchorId = target.id
      return
    }
    const [from, to] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx]
    const ids = new Set(this.selection())
    for (let i = from; i <= to; i++) ids.add(items[i].id)
    this.selection.set(ids)
  }

  protected async bulkDelete(): Promise<void> {
    const files = this.selectedFiles()
    if (files.length === 0) return
    const ok = await this.confirmDialog.open({
      title: 'Move to trash',
      message: 'v3_move_to_trash_n',
      messageParams: { nb: files.length },
      confirmLabel: 'Move to trash',
      kind: 'danger'
    })
    if (!ok) return
    const stubs = files.map((f) => this.buildFileStub(f))
    this.filesService.delete(stubs)
    this.toast.success(files.length === 1 ? `Moving "${files[0].name}" to trash…` : `Moving ${files.length} items to trash…`)
    this.clearSelection()
  }

  protected bulkDownload(): void {
    const files = this.selectedFiles()
    if (files.length === 0) return
    if (files.length === 1 && !files[0].isDir) {
      this.downloadFile(files[0])
      return
    }
    this.startArchiveDownload(files)
  }

  private async startArchiveDownload(files: FileProps[]): Promise<void> {
    const parentSegs = this.pathSegments().map((s) => s.path)
    const defaultName = parentSegs.length ? parentSegs[parentSegs.length - 1] : 'personal'
    const name = await this.promptDialog.open({
      title: 'Download archive',
      placeholder: 'Archive name',
      submitLabel: 'Download',
      initialValue: defaultName,
      selectionRange: 'all',
      validate: (v) => (v.trim() ? null : 'Name is required')
    })
    if (!name) return
    this.filesService.currentRoute = this.currentUploadRoute()
    this.filesService.compress({
      name: name.trim(),
      compressInDirectory: false,
      extension: TAR_GZ_EXTENSION,
      files: files.map((f) => {
        const stub = this.buildFileStub(f)
        return { name: stub.name, rootAlias: SPACE_ALIAS.PERSONAL, path: stub.path }
      })
    })
    this.toast.success(`Archiving ${files.length} items…`)
    this.clearSelection()
  }

  protected async bulkCopyOrMove(op: FILE_OPERATION.COPY | FILE_OPERATION.MOVE): Promise<void> {
    const files = this.selectedFiles()
    if (files.length === 0) return
    const isMove = op === FILE_OPERATION.MOVE
    const dst = await this.treePicker.open({
      title: isMove ? 'Move items' : 'Copy items',
      submitLabel: isMove ? 'Move here' : 'Copy here',
      disabledPath: this.currentUploadRoute()
    })
    if (!dst) return
    const stubs = files.map((f) => this.buildFileStub(f))
    this.filesService.copyMove(stubs, dst.path, op).catch(console.error)
    const verb = isMove ? 'Moving' : 'Copying'
    this.toast.success(files.length === 1 ? `${verb} "${files[0].name}"…` : `${verb} ${files.length} items…`)
    this.clearSelection()
  }

  protected async bulkShare(): Promise<void> {
    const files = this.selectedFiles()
    if (files.length === 0) return
    if (this.selectionHasShares()) {
      this.toast.error('Some selected files are already shared — share them individually.')
      return
    }
    if (files.length === 1) {
      await this.shareEntry(files[0])
      return
    }
    const segs = this.pathSegments().map((s) => s.path)
    const ownerId = this.store.user.getValue()?.id ?? null
    await this.shareDialog.open({
      files: files.map((f) => ({
        file: { id: f.id, name: f.name, isDir: f.isDir, mime: f.mime, space: null as never },
        relativePath: [...segs, f.name].join('/'),
        ownerId
      }))
    })
    this.clearSelection()
    this.refresh()
  }

  protected openEntry(file: FileProps): void {
    if (file.isDir) {
      const segs = this.pathSegments().map((s) => s.path)
      this.router.navigate(['/', V2_PATH, V2_ROUTES.PERSONAL, ...segs, file.name]).catch(console.error)
      return
    }
    const fullPath = this.buildFullPath(file)
    this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: { path: fullPath } }).catch(console.error)
  }

  // Middle-click on a file row → new tab with file-detail.
  // button === 1 is the middle-button code; auxclick fires for non-primary
  // buttons in modern browsers.
  protected onRowAuxClick(event: MouseEvent, file: FileProps): void {
    if (event.button !== 1 || file.isDir) return
    event.preventDefault()
    if (typeof window !== 'undefined') {
      window.open(`/#/${V2_PATH}/${V2_ROUTES.FILE}?path=${encodeURIComponent(this.buildFullPath(file))}`, '_blank', 'noopener')
    }
  }

  private buildFullPath(file: FileProps): string {
    const segs = this.pathSegments().map((s) => s.path)
    return [SPACE_REPOSITORY.FILES, SPACE_ALIAS.PERSONAL, ...segs, file.name].join('/')
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
    this.filesService.copyMove([stub], dst.path, op).catch(console.error)
    this.toast.success(isMove ? `Moving "${file.name}"…` : `Copying "${file.name}"…`)
  }

  private buildFileStub(file: FileProps): FileModel {
    const fullPath = buildSpaceFilePath(
      SPACE_REPOSITORY.FILES,
      SPACE_ALIAS.PERSONAL,
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
    this.filesService.delete([this.buildFileStub(file)])
    this.toast.success(`Moving "${file.name}" to trash…`)
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

  protected async getLink(file: FileProps): Promise<void> {
    const segs = this.pathSegments().map((s) => s.path)
    const relativePath = [...segs, file.name].join('/')
    await this.linkDialog.open({
      file: { id: file.id, name: file.name, isDir: file.isDir, mime: file.mime, space: null as never },
      relativePath,
      ownerId: this.store.user.getValue()?.id ?? null
    })
  }

  protected async shareEntry(file: FileProps): Promise<void> {
    const segs = this.pathSegments().map((s) => s.path)
    const relativePath = [...segs, file.name].join('/')
    await this.shareDialog.open({
      file: { id: file.id, name: file.name, isDir: file.isDir, mime: file.mime, space: null as never },
      relativePath,
      ownerId: this.store.user.getValue()?.id ?? null
    })
  }

  protected openComments(file: FileProps): void {
    if (file.isDir) return
    const fullPath = this.buildFullPath(file)
    this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: { path: fullPath, tab: 'comment' } }).catch(console.error)
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

  protected onNewMenuClick(anchor: HTMLElement): void {
    const r = anchor.getBoundingClientRect()
    this.newMenuAnchor.set({ x: r.left, y: r.bottom + 4 })
    this.newMenuOpen.set(true)
  }

  private dispatchNewEntry(id: NewEntryId): void {
    this.newMenuOpen.set(false)
    switch (id) {
      case 'new-folder':
        this.newFolder()
        return
      case 'new-text':
        this.newTextFile()
        return
      case 'new-docx':
        this.newOfficeFile('docx')
        return
      case 'new-xlsx':
        this.newOfficeFile('xlsx')
        return
      case 'new-pptx':
        this.newOfficeFile('pptx')
        return
    }
  }

  // Auto-named office file. The backend's mkFile copies the matching
  // sample template (assets/samples/sample.<ext>) when the extension is
  // a known DOCUMENT_TYPE — so we get a valid, openable doc with one
  // POST. After creation the file opens straight in the v2 OnlyOffice
  // overlay; refresh runs in the background so the new row appears
  // underneath when the user closes the editor.
  private newOfficeFile(ext: 'docx' | 'xlsx' | 'pptx'): void {
    const dirPath = this.currentUploadRoute()
    const name = this.uniqueName('Untitled', ext)
    const fullPath = `${dirPath}/${name}`
    this.filesService.make('file', name, dirPath, true).subscribe({
      next: () => {
        this.toast.success(`"${name}" created`)
        this.refresh()
        this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: { path: fullPath } }).catch(console.error)
      },
      error: (e: HttpErrorResponse) => {
        this.toast.error(e.error?.message ?? 'File creation failed')
      }
    })
  }

  private uniqueName(stem: string, ext: string): string {
    const taken = new Set(this.files().map((f) => f.name.toLowerCase()))
    const base = `${stem}.${ext}`
    if (!taken.has(base.toLowerCase())) return base
    for (let i = 2; i < 1000; i++) {
      const candidate = `${stem} (${i}).${ext}`
      if (!taken.has(candidate.toLowerCase())) return candidate
    }
    return `${stem}-${Date.now()}.${ext}`
  }

  protected async newFolder(): Promise<void> {
    const name = await this.promptDialog.open({
      title: 'New folder',
      placeholder: 'Folder name',
      submitLabel: 'Create',
      validate: (v) => this.validateEntryName(v)
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

  protected async newTextFile(): Promise<void> {
    const name = await this.promptDialog.open({
      title: 'New text file',
      placeholder: 'File name',
      submitLabel: 'Create',
      initialValue: 'Untitled.txt',
      selectionRange: 'stem',
      validate: (v) => this.validateEntryName(v)
    })
    if (!name) return
    const dirPath = this.currentUploadRoute()
    this.filesService.make('file', name.trim(), dirPath, true).subscribe({
      next: () => {
        this.toast.success(`File "${name.trim()}" created`)
        this.refresh()
      },
      error: (e: HttpErrorResponse) => {
        this.toast.error(e.error?.message ?? 'File creation failed')
      }
    })
  }

  protected async downloadFromUrl(): Promise<void> {
    const url = await this.promptDialog.open({
      title: 'Download from URL',
      placeholder: 'https://…',
      submitLabel: 'Next',
      validate: (v) => (validHttpSchemaRegexp.test(v.trim()) ? null : 'Malformed URL')
    })
    if (!url) return
    const derivedName = url.trim().split('/').filter(Boolean).pop() ?? ''
    const name = await this.promptDialog.open({
      title: 'Save as',
      placeholder: 'File name',
      submitLabel: 'Download',
      initialValue: derivedName,
      selectionRange: 'stem',
      validate: (v) => this.validateEntryName(v)
    })
    if (!name) return
    this.filesService.currentRoute = this.currentUploadRoute()
    this.filesService.downloadFromUrl(url.trim(), name.trim())
    this.toast.success(`Downloading "${name.trim()}"…`)
  }

  private validateEntryName(v: string): string | null {
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

  // Dispatch the mobile FAB action sheet's selection back to the
  // existing toolbar handlers — keeps a single implementation per
  // action and avoids the sheet drifting from desktop behavior.
  protected onFabSheetSelect(id: string): void {
    switch (id) {
      case 'new-folder':
        this.newFolder()
        return
      case 'new-text':
        this.newTextFile()
        return
      case 'new-docx':
        this.newOfficeFile('docx')
        return
      case 'new-xlsx':
        this.newOfficeFile('xlsx')
        return
      case 'new-pptx':
        this.newOfficeFile('pptx')
        return
      case 'download-url':
        this.downloadFromUrl()
        return
      case 'upload':
        this.triggerFilePicker()
        return
    }
  }

  protected onFilePicked(event: Event): void {
    const input = event.target as HTMLInputElement
    const files = input.files
    if (!files || files.length === 0) return
    this.uploadFiles(Array.from(files))
  }

  protected onDropFiles(event: DragEvent): void {
    this.filesService.currentRoute = this.currentUploadRoute()
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
    const segs = this.pathSegments().map((s) => s.path)
    return [SPACE_REPOSITORY.FILES, SPACE_ALIAS.PERSONAL, ...segs].join('/')
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
