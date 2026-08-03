import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import {
  computed,
  DestroyRef,
  Directive,
  effect,
  ElementRef,
  HostListener,
  inject,
  OnDestroy,
  OnInit,
  signal,
  ViewChild,
  viewChild
} from '@angular/core'
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop'
import { ActivatedRoute, Router } from '@angular/router'
import { L10N_LOCALE, L10nLocale } from 'angular-l10n'
import { FILE_OPERATION } from '@sync-in-server/backend/src/applications/files/constants/operations'
import { API_FILES_OPERATION } from '@sync-in-server/backend/src/applications/files/constants/routes'
import type { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { API_SPACES_BROWSE } from '@sync-in-server/backend/src/applications/spaces/constants/routes'
import { SPACE_REPOSITORY } from '@sync-in-server/backend/src/applications/spaces/constants/spaces'
import type { SpaceFiles } from '@sync-in-server/backend/src/applications/spaces/interfaces/space-files.interface'
import { encodeUrl } from '@sync-in-server/backend/src/common/shared'
import { Subscription } from 'rxjs'
import { filter } from 'rxjs/operators'
import { validHttpSchemaRegexp } from '../../../../common/utils/regexp'
import { StoreService } from '../../../../store/store.service'
import type { FileEvent } from '../../../files/interfaces/file-event.interface'
import type { FileUpload } from '../../../files/interfaces/file-upload.interface'
import type { FileModel } from '../../../files/models/file.model'
import { fileLockPropsToString } from '../../../files/components/utils/file-lock.utils'
import { FilesService } from '../../../files/services/files.service'
import { FilesUploadService } from '../../../files/services/files-upload.service'
import type { ActionSheetEntry } from '../../components/action-sheet.component'
import { CompressDialogService } from '../../components/compress-dialog.service'
import { ConfirmDialogService } from '../../components/confirm-dialog.service'
import type { ContextMenuAnchor, ContextMenuEntry, ContextMenuItem } from '../../components/context-menu.component'
import { LinkDialogService } from '../../components/link-dialog.service'
import { LockDialogService } from '../../components/lock-dialog.service'
import { PromptDialogService } from '../../components/prompt-dialog.service'
import { ShareDialogService } from '../../components/share-dialog.service'
import { ToastService } from '../../components/toast.service'
import { TreePickerService } from '../../components/tree-picker.service'
import type { IconV2Name } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { DockRailService, FILE_BROWSER_DOCK_TABS } from '../../layout/dock-rail.service'
import { FavoritesService } from '../../services/favorites.service'
import { FolderSizeService } from '../../services/folder-size.service'
import { V2DragService } from '../../services/drag.service'
import { FolderReadmeComponent } from '../../components/folder-readme.component'
import { buildFileModelStub, buildSpaceFilePath } from '../../utils/file-model-stub'
import { FOLDER_README_NAMES, pickFolderReadme } from '../../utils/folder-readme'
import { isArchiveMime, mimeToGlyph } from '../../utils/mime-to-glyph'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'
import { buildNewEntryMenu, buildNewEntrySheetItems, NewEntryId } from './new-entry-menu'
import type { FileBrowserRepository } from './file-browser-repository'

export type BrowserMode = 'list' | 'grid' | 'gallery'

export interface BrowserViewOption {
  id: BrowserMode
  icon: IconV2Name
  title: string
}

function readStoredMode(key: string): BrowserMode {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return 'list'
  const raw = window.localStorage.getItem(key)
  return raw === 'grid' || raw === 'gallery' || raw === 'list' ? raw : 'list'
}

// The ONE v2 file browser. Both `PersonalComponent` and `SpaceFilesComponent`
// extend this and render the same template + stylesheet
// (file-browser.component.html / .scss); all they add is a
// `FileBrowserRepository` describing where their files live. Read that
// interface for the full list of what may differ — everything else is here,
// once.
//
// Declared `@Directive()` with no selector (Angular's abstract-directive form)
// so host listeners, view queries and `inject()` are inherited by the two
// component subclasses. Nothing renders this directly.
@Directive()
export abstract class FileBrowserBase implements OnInit, OnDestroy {
  /**
   * The repository strategy. Dereferenced lazily only — from methods, effects
   * and computed signals — never during field initialisation, because base
   * fields initialise before the subclass field that holds it.
   */
  protected abstract readonly repository: FileBrowserRepository

  /**
   * Platform-aware label for the filter shortcut hint — the kbd badge next to
   * the filter input. On the base rather than in the repository because it is
   * derived from the platform, not from the screen: both browsers want the
   * identical string, and a repository field would invite a second screen to
   * hard-code a different one. That is exactly what happened (#368) — one
   * screen hard-coded '⌘F' and told every Linux and Windows user the wrong
   * key, while also not wiring the shortcut up at all.
   *
   * Safe as a field initialiser: it touches only `navigator`, never
   * `repository`, which is still undefined while base fields initialise.
   */
  protected readonly filterShortcutLabel: string = (() => {
    if (typeof navigator === 'undefined') return 'Ctrl F'
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '') || /Mac/.test(navigator.userAgent || '')
    return isMac ? '⌘F' : 'Ctrl F'
  })()

  /**
   * localStorage key for the view mode.
   *
   * A METHOD rather than a `repository` field on purpose: `mode` below is
   * initialised while the subclass's `repository` field is still undefined, and
   * prototype methods (unlike fields) already resolve at that point.
   */
  protected abstract viewModeStorageKey(): string

  protected readonly http = inject(HttpClient)
  protected readonly route = inject(ActivatedRoute)
  protected readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  protected readonly filesService = inject(FilesService)
  private readonly folderSize = inject(FolderSizeService)
  protected readonly favoritesService = inject(FavoritesService)
  private readonly filesUpload = inject(FilesUploadService)
  private readonly confirmDialog = inject(ConfirmDialogService)
  private readonly treePicker = inject(TreePickerService)
  private readonly promptDialog = inject(PromptDialogService)
  private readonly compressDialog = inject(CompressDialogService)
  private readonly linkDialog = inject(LinkDialogService)
  private readonly lockDialog = inject(LockDialogService)
  private readonly shareDialog = inject(ShareDialogService)
  private readonly toast = inject(ToastService)
  protected readonly store = inject(StoreService)
  private readonly dockRail = inject(DockRailService)
  protected readonly drag = inject(V2DragService)
  private readonly destroyRef = inject(DestroyRef)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private navSubscription: Subscription | null = null
  private unregisterDropHandler: (() => void) | null = null

  // Per-row drop-target hover signal. The id of the file-row currently being
  // hovered as a drop target during an in-flight drag; null when no drop target
  // is hovered. The template binds the row's `.drop-hover` class to this.
  protected readonly dropHoverId = signal<number | null>(null)

  @ViewChild('fileInput') protected fileInput?: ElementRef<HTMLInputElement>
  @ViewChild('filterInput') protected filterInput?: ElementRef<HTMLInputElement>

  // The folder-readme banner rendered above the listing by the shared template.
  // Queried here so `newFolderDescription()` can hand the freshly created file
  // straight to its editor, and so the template's filter gate can ask whether an
  // edit is in progress. Readme behaviour is identical on both screens, so it
  // lives on the base and NOT in FileBrowserRepository — that seam is only for
  // where files come from and how they are addressed on the wire.
  protected readonly readmeBanner = viewChild(FolderReadmeComponent)

  protected readonly mimeToGlyph = mimeToGlyph
  protected readonly FILE_OPERATION = FILE_OPERATION
  protected readonly files = signal<FileProps[]>([])
  // The browse response's permission string, kept for the folder readme banner's
  // writeability check. `SpaceFiles` carries it on every response and both
  // screens read the same field.
  protected readonly permissions = signal<string>('')
  // The folder path the CURRENT `files`/`permissions` describe — not the folder
  // the router is pointing at.
  //
  // `currentUploadRoute()` derives its answer from the URL, so it flips
  // synchronously on navigation, while `files` is only written when the listing
  // GET returns. For everything else in this class that gap is invisible, because
  // they read the route at the moment the user acts. The folder-readme banner is
  // different: it holds all three at once and composes a file path out of them.
  // Given the route path and the previous folder's rows — and `loadFiles()`
  // deliberately does not blank `files` while loading, so the old listing stays on
  // screen — it would build `<new folder>/<old folder's readme name>` and open an
  // editor on a file that need not exist. So publish the path in the same turn as
  // the rows it belongs to, and let the banner bind to this instead.
  protected readonly loadedDirPath = signal<string>('')
  // Gates the New menu's "Folder description" entry — hidden once the current
  // folder already has one, matching Nextcloud's Rich Workspaces "+" menu.
  protected readonly hasFolderReadme = computed(() => pickFolderReadme(this.files()) !== null)
  protected readonly loading = signal(true)
  protected readonly errorMessage = signal<string | null>(null)
  protected readonly filter = signal('')
  protected readonly mode = signal<BrowserMode>(readStoredMode(this.viewModeStorageKey()))
  protected readonly menu = signal<{ file: FileProps; x: number; y: number } | null>(null)

  // Mobile FAB-driven action sheet. Mirrors the desktop "+ New" menu, then
  // tacks on the FAB-only Upload primitive.
  protected readonly fabSheetOpen = signal(false)
  protected readonly fabSheetItems = computed<readonly ActionSheetEntry[]>(() => [
    ...buildNewEntrySheetItems(this.hasFolderReadme()),
    { id: 'sep-fab', kind: 'divider' },
    { id: 'upload', label: 'Upload', icon: 'upload' }
  ])

  // Desktop "+ New" dropdown — anchored under the primary toolbar button.
  protected readonly newMenuOpen = signal(false)
  protected readonly newMenuAnchor = signal<ContextMenuAnchor | null>(null)
  protected readonly newMenuItems = computed<ContextMenuEntry[]>(() =>
    buildNewEntryMenu({
      onSelect: (id) => this.dispatchNewEntry(id),
      hasFolderReadme: this.hasFolderReadme()
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
    if (segs.length === 0) return this.repository.rootLabel()
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
      // Decompress: single archive file only (mirrors classic's
      // `decompressFile` gate — single selection, file is an archive).
      ...(!f.isDir && isArchiveMime(f.mime)
        ? [{ id: 'decompress', label: 'Decompress', icon: 'archive' as IconV2Name, action: () => this.decompressEntry(f) }]
        : []),
      { id: 'rename', label: 'Rename', icon: 'pencil', action: () => this.renameEntry(f) },
      {
        id: 'size',
        label: 'Calculate size',
        icon: 'refresh',
        disabled: !f.isDir,
        disabledReason: !f.isDir ? 'Folders only' : undefined,
        action: () => this.calculateFolderSize(f)
      },
      { id: 'copy', label: 'Copy to…', icon: 'copy', action: () => this.copyOrMove(f, FILE_OPERATION.COPY) },
      { id: 'move', label: 'Move to…', icon: 'moveTo', action: () => this.copyOrMove(f, FILE_OPERATION.MOVE) },
      { id: 'get-link', label: 'Get link', icon: 'link', action: () => this.getLink(f) },
      { id: 'share', label: 'Share', icon: 'share', action: () => this.shareEntry(f) },
      {
        id: 'favorite',
        label: this.favoritesService.isFavorite(f.id) ? 'Remove from favorites' : 'Add to favorites',
        icon: 'star',
        action: () => this.toggleFavorite(f)
      },
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
    // Push the single-row selection into the dock context so the right panel's
    // Info / Comments tabs render against it. Multi-select, empty-select or an
    // unresolved repository clears the panel back to its empty state.
    effect(() => {
      const sel = this.selectedFiles()
      const alias = this.repository.alias()
      if (sel.length !== 1 || !alias) {
        this.dockRail.currentSelected.set(null)
        return
      }
      const f = sel[0]
      this.dockRail.currentSelected.set({
        id: f.id,
        name: f.name,
        path: this.buildFullPath(f),
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
    // Register the drag-and-drop move handler. V2DragService invokes this when a
    // drop happens via a shared component (the breadcrumb) — the file-row drop
    // in the template calls executeMove directly, but threading both through the
    // same path keeps the toast and selection-clear behaviour consistent.
    this.unregisterDropHandler = this.drag.registerDropHandler((targetPath, files) => this.executeMove(targetPath, files))
    this.navSubscription = this.repository.navigation().subscribe(() => {
      this.syncBreadcrumbs()
      this.clearSelection()
      this.folderSize.clear()
      this.loadFiles()
      this.favoritesService.loadFavoriteIds()
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
    if (this.repository.autoDownloadTaskArchive) {
      // Trigger a browser download when a compress-to-archive task completes.
      // The task service emits archiveId on the event; classic spaces-browser
      // handles this in onFileEvent().
      this.store.filesOnEvent
        .pipe(
          filter((ev: FileEvent | null) => !!ev?.archiveId),
          takeUntilDestroyed(this.destroyRef)
        )
        .subscribe((ev) => this.filesService.downloadTaskArchive(ev!.archiveId!))
    }
  }

  ngOnDestroy(): void {
    this.navSubscription?.unsubscribe()
    this.unregisterDropHandler?.()
    this.folderSize.clear()
    this.dockRail.clear()
    this.repository.onDestroy?.()
  }

  // Drag-and-drop move handlers. dragstart picks up the selection (or just the
  // row if it's not selected) and stamps the V2DragService payload. Drop on a
  // folder row routes through executeMove — dropping on a breadcrumb segment
  // routes via V2DragService.dropOnPath ⇒ the handler registered in ngOnInit ⇒
  // executeMove.
  protected onRowDragStart(event: DragEvent, file: FileProps): void {
    const files = this.isSelected(file) ? this.selectedFiles() : [file]
    this.drag.start(files, this.currentUploadRoute())
    if (event.dataTransfer) {
      // Some browsers refuse to start a drag without any data on dataTransfer.
      // The text payload is also useful for cross-app drags (e.g. dragging into
      // a text editor) — even if the in-app drop never reads it.
      event.dataTransfer.setData('text/plain', files.map((f) => f.name).join(', '))
      event.dataTransfer.effectAllowed = 'move'
    }
  }

  protected onRowDragEnd(): void {
    this.dropHoverId.set(null)
    this.drag.end()
  }

  protected onRowDragOver(event: DragEvent, file: FileProps): void {
    if (!this.drag.canDropOnFile(file)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    if (this.dropHoverId() !== file.id) this.dropHoverId.set(file.id)
  }

  protected onRowDragLeave(file: FileProps): void {
    if (this.dropHoverId() === file.id) this.dropHoverId.set(null)
  }

  protected onRowDrop(event: DragEvent, file: FileProps): void {
    event.preventDefault()
    this.dropHoverId.set(null)
    if (!this.drag.canDropOnFile(file)) {
      this.drag.end()
      return
    }
    const payload = this.drag.payload()
    if (!payload) return
    const targetPath = `${this.currentUploadRoute()}/${file.name}`
    this.executeMove(targetPath, payload.files)
    this.drag.end()
  }

  private executeMove(targetPath: string, files: FileProps[]): void {
    if (files.length === 0) return
    const stubs = files.map((f) => this.buildFileStub(f))
    this.filesService.copyMove(stubs, targetPath, FILE_OPERATION.MOVE).catch(console.error)
    if (files.length === 1) {
      this.toast.success('v2_moving_one_progress', { name: files[0].name })
    } else {
      this.toast.success('v2_moving_n_progress', { nb: files.length })
    }
    this.clearSelection()
  }

  protected setMode(mode: BrowserMode): void {
    this.mode.set(mode)
    if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
      window.localStorage.setItem(this.viewModeStorageKey(), mode)
    }
  }

  protected refresh(): void {
    this.loadFiles()
  }

  @HostListener('window:keydown', ['$event'])
  protected onWindowKeydown(event: KeyboardEvent): void {
    // Cmd/Ctrl+F focuses the filter input, preempting the browser's built-in
    // Find dialog. Honored from anywhere on the screen — even when focus is
    // already in another input — because the kbd hint next to the filter
    // promises this and a stuck-elsewhere focus would surprise the user.
    if (this.repository.filterShortcutEnabled && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
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
      message: 'v2_move_to_trash_n',
      messageParams: { nb: files.length },
      confirmLabel: 'Move to trash',
      kind: 'danger'
    })
    if (!ok) return
    const stubs = files.map((f) => this.buildFileStub(f))
    this.filesService.delete(stubs)
    if (files.length === 1) {
      this.toast.success('v2_moving_to_trash_one_progress', { name: files[0].name })
    } else {
      this.toast.success('v2_moving_to_trash_n_progress', { nb: files.length })
    }
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
    const defaultName = parentSegs.length ? parentSegs[parentSegs.length - 1] : this.repository.rootArchiveName()
    const archive = await this.compressDialog.open({
      initialValue: defaultName,
      fileCount: files.length,
      validate: (v) => (v.trim() ? null : 'Name is required')
    })
    if (!archive) return
    this.filesService.currentRoute = this.currentUploadRoute()
    const rootAlias = this.repository.compressRootAlias()
    this.filesService.compress({
      name: archive.name,
      compressInDirectory: archive.compressInDirectory,
      compression: archive.compression,
      extension: archive.extension,
      files: files.map((f) => {
        const stub = this.buildFileStub(f)
        return { name: stub.name, rootAlias, path: stub.path }
      })
    })
    this.toast.success('v2_archiving_n_progress', { nb: files.length })
    this.clearSelection()
  }

  protected decompressEntry(file: FileProps): void {
    // Mirrors classic `decompressFile`: set currentRoute to the target folder,
    // then POST to the decompress task endpoint. Listing refreshes when the task
    // completes via the shared filesOnEvent subscription (see ngOnInit).
    this.filesService.currentRoute = this.currentUploadRoute()
    this.filesService.decompress(this.buildFileStub(file))
    this.toast.success('v2_decompressing_progress', { name: file.name })
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
    if (files.length === 1) {
      this.toast.success(isMove ? 'v2_moving_one_progress' : 'v2_copying_one_progress', { name: files[0].name })
    } else {
      this.toast.success(isMove ? 'v2_moving_n_progress' : 'v2_copying_n_progress', { nb: files.length })
    }
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
    const space = this.repository.dialogSpace() as never
    const ownerId = this.repository.dialogOwnerId()
    await this.shareDialog.open({
      files: files.map((f) => ({
        file: { id: f.id, name: f.name, isDir: f.isDir, mime: f.mime, space },
        relativePath: [...segs, f.name].join('/'),
        ownerId
      }))
    })
    this.clearSelection()
    this.refresh()
  }

  protected openEntry(file: FileProps): void {
    if (!this.repository.alias()) return
    if (file.isDir) {
      const segs = this.pathSegments().map((s) => s.path)
      this.router.navigate(this.repository.folderRoute([...segs, file.name])).catch(console.error)
      return
    }
    const fullPath = this.buildFullPath(file)
    this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: { path: fullPath } }).catch(console.error)
  }

  // Middle-click on a file row → new tab with file-detail. button === 1 is the
  // middle-button code; auxclick fires for non-primary buttons in modern
  // browsers.
  protected onRowAuxClick(event: MouseEvent, file: FileProps): void {
    if (event.button !== 1 || file.isDir) return
    if (!this.repository.alias()) return
    event.preventDefault()
    if (typeof window !== 'undefined') {
      window.open(`/#/${V2_PATH}/${V2_ROUTES.FILE}?path=${encodeURIComponent(this.buildFullPath(file))}`, '_blank', 'noopener')
    }
  }

  private buildFullPath(file: FileProps): string {
    const segs = this.pathSegments().map((s) => s.path)
    return [SPACE_REPOSITORY.FILES, this.repository.alias(), ...segs, file.name].join('/')
  }

  /**
   * The addressable, repository-qualified path of a row in the CURRENT listing —
   * what `app-v2-file-thumb` needs to build its thumbnail URL (#428).
   *
   * Keys on `loadedDirPath()` rather than the route, for the same reason the
   * folder-readme banner does: a thumbnail describes a row that is already on
   * screen, and `loadFiles()` deliberately leaves the previous listing visible
   * while the next one loads — so between a navigation and its response the
   * route names the new folder while `files()` still holds the old rows. Using
   * `buildFullPath` here would request `<new folder>/<old row's name>` for that
   * window. Returns '' before the first listing lands (and after a failed one),
   * which the component reads as "no address yet" and renders the glyph.
   *
   * The repository prefix comes in through `loadedDirPath`, which is written from
   * `repository.alias()`, so both screens get their own answer without an `if`.
   */
  protected thumbPath(file: FileProps): string {
    const dir = this.loadedDirPath()
    return dir ? `${dir}/${file.name}` : ''
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
    this.toast.success(isMove ? 'v2_moving_one_progress' : 'v2_copying_one_progress', { name: file.name })
  }

  private buildFileStub(file: FileProps): FileModel {
    return buildFileModelStub(file, this.buildSpacePath(file))
  }

  private buildSpacePath(file: FileProps): string {
    return buildSpaceFilePath(
      SPACE_REPOSITORY.FILES,
      this.repository.alias(),
      this.pathSegments().map((s) => s.path),
      file.name
    )
  }

  protected folderSizeState(fileId: number) {
    return this.folderSize.state(fileId)
  }

  protected calculateFolderSize(file: FileProps): void {
    // Same path-building as `buildFileStub` so FolderSizeService receives the
    // full server path it needs to construct the URL.
    this.folderSize.compute(file, this.buildSpacePath(file))
  }

  // Star toggle. Builds the same repository path the dock-context effect uses
  // (files/<alias>/<segs>/<name>) and hands it to FavoritesService, which
  // optimistically flips the id Set before firing the add/remove request.
  protected toggleFavorite(file: FileProps): void {
    if (!this.repository.alias()) return
    this.favoritesService.toggle(this.buildFullPath(file), file.id, !this.favoritesService.isFavorite(file.id))
  }

  protected async confirmAndDelete(file: FileProps): Promise<void> {
    const ok = await this.confirmDialog.open({
      title: 'Move to trash',
      message: 'v2_move_to_trash_one',
      messageParams: { name: file.name },
      confirmLabel: 'Move to trash',
      kind: 'danger'
    })
    if (!ok) return
    this.filesService.delete([this.buildFileStub(file)])
    this.toast.success('v2_moving_to_trash_one_progress', { name: file.name })
  }

  protected downloadFile(file: FileProps): void {
    if (file.isDir) return
    const url = `${API_FILES_OPERATION}/${encodeUrl(this.buildFullPath(file))}`
    if (typeof window !== 'undefined') {
      window.open(url, '_self')
    }
  }

  protected async getLink(file: FileProps): Promise<void> {
    const segs = this.pathSegments().map((s) => s.path)
    await this.linkDialog.open({
      file: { id: file.id, name: file.name, isDir: file.isDir, mime: file.mime, space: this.repository.dialogSpace() as never },
      relativePath: [...segs, file.name].join('/'),
      ownerId: this.repository.dialogOwnerId()
    })
  }

  protected async shareEntry(file: FileProps): Promise<void> {
    const segs = this.pathSegments().map((s) => s.path)
    await this.shareDialog.open({
      file: { id: file.id, name: file.name, isDir: file.isDir, mime: file.mime, space: this.repository.dialogSpace() as never },
      relativePath: [...segs, file.name].join('/'),
      ownerId: this.repository.dialogOwnerId()
    })
  }

  // ---------------------------------------------------------------------------
  // Locks
  //
  // Parity target: classic's clickable lock badge on a locked row
  // (spaces-browser.component.html:252 list / :427 gallery →
  // `filesService.openLockDialog`). The affordance is the badge, NOT a
  // context-menu entry, and it is unlock-only: classic offers no way to TAKE a
  // lock, because `filesService.lock()` belongs to editor sessions (including
  // v2's own markdown and text/code editors). Do not add one here.
  // ---------------------------------------------------------------------------

  /** Tooltip text for a locked row — `Full Name (email) - <info> <app>`, classic's FileLockFormatPipe. */
  protected lockLabel(file: FileProps): string {
    return file.lock ? fileLockPropsToString(file.lock) : ''
  }

  /**
   * Classic's `isFileOwner`, both halves: the screen-level fact
   * (`spacesBrowserService.inPersonalSpace`, here `repository.filesAreOwnedByUser`)
   * short-circuits the per-row one (`file.root?.owner?.login === userLogin`).
   */
  protected isFileOwner(file: FileProps): boolean {
    if (this.repository.filesAreOwnedByUser) return true
    const login = this.store.user.getValue()?.login
    return !!login && file.root?.owner?.login === login
  }

  protected async openLockDialog(file: FileProps): Promise<void> {
    const lock = file.lock
    if (!lock) return
    const isFileOwner = this.isFileOwner(file)
    const choice = await this.lockDialog.open({ fileName: file.name, lock, isFileOwner })
    if (choice === 'unlock') this.unlockFile(file, isFileOwner)
    else if (choice === 'request') this.requestUnlock(file)
  }

  // `forceAsFileOwner` is classic's second argument to `unlock` verbatim — it
  // sets the FORCE_AS_FILE_OWNER query param (files.service.ts:239), and classic
  // passes `isFileOwner` regardless of whether the user also holds the lock.
  private unlockFile(file: FileProps, forceAsFileOwner: boolean): void {
    this.filesService.unlock(this.buildFileStub(file), forceAsFileOwner).subscribe({
      next: () => {
        // Optimistic strip so the badge goes at once (classic does the same with
        // `file.removeLock()`), then refresh — the browse response is the
        // authority on whether the lock is really gone.
        this.stripLock(file.id)
        this.toast.success('v2_file_unlocked', { name: file.name })
        this.refresh()
      },
      error: (e: HttpErrorResponse) => this.toast.error(this.lockErrorMessage(e, 'Unlock failed'))
    })
  }

  private requestUnlock(file: FileProps): void {
    this.filesService.unlockRequest(this.buildFileStub(file)).subscribe({
      next: () => this.toast.success('v2_unlock_request_sent', { owner: file.lock?.owner?.fullName ?? file.lock?.owner?.login ?? '' }),
      error: (e: HttpErrorResponse) => this.toast.error(this.lockErrorMessage(e, 'Unlock request failed'))
    })
  }

  private stripLock(fileId: number): void {
    this.files.update((rows) => rows.map((f) => (f.id === fileId ? { ...f, lock: undefined } : f)))
  }

  /**
   * The lock endpoints do NOT reliably answer with `{ message }`.
   * `FileError` and `LockConflict` extend `Error` rather than `HttpException`, so
   * whatever reaches the wire depends on the translation layer in front of them:
   * a 409 lock conflict answers with a bare `FileLockProps` body (which is why
   * the text editor reads `e.error as FileLockProps`), and an untranslated throw
   * answers with a plain 500 whose body carries no message at all. So take a
   * message only when there is a string one, and otherwise show our own.
   */
  private lockErrorMessage(e: HttpErrorResponse, fallback: string): string {
    const body: unknown = e?.error
    if (typeof body === 'string' && body.trim()) return body
    const message = (body as { message?: unknown } | null)?.message
    if (typeof message === 'string' && message.trim()) return message
    return fallback
  }

  protected openComments(file: FileProps): void {
    if (file.isDir) return
    if (!this.repository.alias()) return
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
    const stub = this.buildFileStub(file)
    this.filesService.rename(stub, trimmed, false).subscribe({
      next: () => {
        this.toast.success('v2_renamed_to', { name: trimmed })
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

  protected onNewMenuClick(anchor: HTMLElement): void {
    const r = anchor.getBoundingClientRect()
    this.newMenuAnchor.set({ x: r.left, y: r.bottom + 4 })
    this.newMenuOpen.set(true)
  }

  protected dispatchNewEntry(id: NewEntryId): void {
    this.newMenuOpen.set(false)
    switch (id) {
      case 'new-folder':
        this.newFolder()
        return
      case 'new-text':
        this.newTextFile()
        return
      case 'new-markdown':
        this.newMarkdownFile()
        return
      // ONE case, covering the desktop dropdown AND the mobile FAB sheet: the
      // sheet's create ids delegate to this switch (see onFabSheetSelect below),
      // so there is no second dispatcher to keep in step.
      case 'new-folder-description':
        this.newFolderDescription()
        return
      case 'new-diagram':
        this.newDiagramFile()
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
      case 'new-download-url':
        this.downloadFromUrl()
        return
    }
  }

  // Dispatch the mobile FAB action-sheet selection. The sheet emits a string id;
  // the create ids delegate to dispatchNewEntry so the sheet can never drift
  // from the desktop dropdown. `upload` is FAB-only since it isn't a create
  // action.
  protected onFabSheetSelect(id: string): void {
    if (this.repository.closeActionSheetOnSelect) this.fabSheetOpen.set(false)
    if (id === 'upload') {
      this.triggerFilePicker()
      return
    }
    this.dispatchNewEntry(id as NewEntryId)
  }

  private newDiagramFile(): void {
    const dirPath = this.currentUploadRoute()
    const name = this.uniqueName('Untitled diagram', 'drawio')
    this.http.post<{ path: string }>('/api/diagrams/new', { dirPath, name }).subscribe({
      next: (res) => {
        this.toast.success('v2_item_created', { name })
        this.refresh()
        this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: { path: res.path } }).catch(console.error)
      },
      error: (e: HttpErrorResponse) => {
        this.toast.error(e.error?.message ?? 'Diagram creation failed')
      }
    })
  }

  // Auto-named office file. The backend's mkFile copies the matching sample
  // template (assets/samples/sample.<ext>) when the extension is a known
  // DOCUMENT_TYPE — so we get a valid, openable doc with one POST. With an
  // Office editor the file opens straight in the v2 overlay; without one we
  // still create the file (downloadable/syncable) but skip the navigate so the
  // user isn't dumped on a dead viewer.
  private newOfficeFile(ext: 'docx' | 'xlsx' | 'pptx'): void {
    const dirPath = this.currentUploadRoute()
    const name = this.uniqueName('Untitled', ext)
    const fullPath = `${dirPath}/${name}`
    const officeEditorOn = this.store.server().files.editors.onlyoffice || this.store.server().files.editors.eurooffice
    this.filesService.make('file', name, dirPath, true).subscribe({
      next: () => {
        this.toast.success('v2_item_created', { name })
        this.refresh()
        if (officeEditorOn) {
          this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: { path: fullPath } }).catch(console.error)
        }
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
        this.toast.success('v2_folder_created', { name: name.trim() })
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
        this.toast.success('v2_file_created', { name: name.trim() })
        this.refresh()
      },
      error: (e: HttpErrorResponse) => {
        this.toast.error(e.error?.message ?? 'File creation failed')
      }
    })
  }

  // Markdown gets the office-style flow: pre-fill the name, copy the .md sample
  // template, then open the new file in v2's TipTap editor so the user can start
  // typing immediately.
  protected async newMarkdownFile(): Promise<void> {
    const initial = this.uniqueName('Untitled', 'md')
    const name = await this.promptDialog.open({
      title: 'New markdown file',
      placeholder: 'File name',
      submitLabel: 'Create',
      initialValue: initial,
      selectionRange: 'stem',
      validate: (v) => this.validateEntryName(v)
    })
    if (!name) return
    const trimmed = name.trim()
    const dirPath = this.currentUploadRoute()
    const fullPath = `${dirPath}/${trimmed}`
    this.filesService.make('file', trimmed, dirPath, true).subscribe({
      next: () => {
        this.toast.success('v2_file_created', { name: trimmed })
        this.refresh()
        this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: { path: fullPath } }).catch(console.error)
      },
      error: (e: HttpErrorResponse) => {
        this.toast.error(e.error?.message ?? 'File creation failed')
      }
    })
  }

  // Creates the folder description with a fixed name and no prompt, then hands
  // straight to the banner's editor — no navigation to file-detail, unlike
  // newMarkdownFile above. FOLDER_README_NAMES[0] is 'Readme.md', NC's default.
  protected newFolderDescription(): void {
    const name = FOLDER_README_NAMES[0]
    const dirPath = this.currentUploadRoute()
    // Clear any active filter BEFORE the request, not in the next handler: the
    // filter gate in the shared template unmounts the banner, and `startEdit()`
    // below reaches it through an optional viewChild that resolves to undefined
    // while it is unmounted — so the edit intent would silently vanish. Clearing
    // here gives Angular a change-detection pass to mount it while the request is
    // in flight. A filter would also hide the new Readme.md row from the listing
    // unless it happened to match.
    //
    // Restored if creation fails, so a failure does not also cost the user the
    // query they had typed.
    const previousFilter = this.filter()
    this.filter.set('')
    this.filesService.make('file', name, dirPath, true).subscribe({
      next: () => {
        this.toast.success('v2_file_created', { name })
        this.refresh()
        // The banner queues this until the refreshed listing resolves the file.
        this.readmeBanner()?.startEdit()
      },
      error: (e: HttpErrorResponse) => {
        this.filter.set(previousFilter)
        this.toast.error(e?.error?.message ?? 'Creation failed')
      }
    })
  }

  // Two-step prompt mirrors classic's download dialog: collect URL, then offer a
  // derived name the user can rename. Backend kicks off an async download task —
  // no auto-navigate because the file isn't available until the task finishes.
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
    this.toast.success('v2_downloading_one', { name: name.trim() })
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

  // The folder the ROUTE currently points at. Callers that act on a user gesture
  // want this; anything that has to agree with the loaded listing wants
  // `loadedDirPath` instead.
  private currentUploadRoute(): string {
    const segs = this.pathSegments().map((s) => s.path)
    return [SPACE_REPOSITORY.FILES, this.repository.alias(), ...segs].join('/')
  }

  private loadFiles(): void {
    const alias = this.repository.alias()
    if (!alias) return
    this.loading.set(true)
    this.errorMessage.set(null)
    const segs = this.pathSegments().map((s) => s.path)
    const dirPath = this.currentUploadRoute()
    const url = [API_SPACES_BROWSE, SPACE_REPOSITORY.FILES, alias, ...segs].join('/')
    this.http.get<SpaceFiles>(url).subscribe({
      next: (result) => {
        this.files.set(result.files)
        this.permissions.set(result.permissions ?? '')
        // Published in the same turn as files/permissions, and carrying the path
        // this response was requested for — see loadedDirPath's own comment.
        this.loadedDirPath.set(dirPath)
        this.loading.set(false)
        this.repository.onListingLoaded?.(alias)
      },
      error: (e: HttpErrorResponse) => {
        this.files.set([])
        // Cleared on the error path too: a stale permission string from the
        // previous folder would let the banner offer Edit on content it could
        // not load.
        this.permissions.set('')
        this.loadedDirPath.set('')
        this.errorMessage.set(e.status === 404 ? 'Folder not found' : 'Failed to load folder')
        this.loading.set(false)
      }
    })
  }

  protected syncBreadcrumbs(): void {
    if (!this.repository.alias()) return
    this.breadcrumbs.setBreadcrumbs(this.repository.breadcrumbs(this.pathSegments().map((s) => s.path)))
  }
}
