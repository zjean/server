import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, OnDestroy, OnInit, signal } from '@angular/core'
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop'
import { ActivatedRoute, Router } from '@angular/router'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { API_SPACES_BROWSE } from '@sync-in-server/backend/src/applications/spaces/constants/routes'
import { SPACE_REPOSITORY } from '@sync-in-server/backend/src/applications/spaces/constants/spaces'
import { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { SpaceFiles } from '@sync-in-server/backend/src/applications/spaces/interfaces/space-files.interface'
import { combineLatest, Subscription } from 'rxjs'
import { filter } from 'rxjs/operators'
import { FileEvent } from '../../../files/interfaces/file-event.interface'
import { ToBytesPipe } from '../../../../common/pipes/to-bytes.pipe'
import { TimeAgoPipe } from '../../../../common/pipes/time-ago.pipe'
import { StoreService } from '../../../../store/store.service'
import { FilesService } from '../../../files/services/files.service'
import { FileModel } from '../../../files/models/file.model'
import { buildFileModelStub, buildSpaceFilePath } from '../../utils/file-model-stub'
import { ButtonComponent } from '../../components/button.component'
import { ConfirmDialogService } from '../../components/confirm-dialog.service'
import { ContextMenuComponent, ContextMenuItem } from '../../components/context-menu.component'
import { FileGlyphComponent } from '../../components/file-glyph.component'
import { IconButtonComponent } from '../../components/icon-button.component'
import { PillComponent } from '../../components/pill.component'
import { ToastService } from '../../components/toast.service'
import { IconV2Component } from '../../icons/icon-v2.component'
import { V2BreadcrumbService, BreadcrumbSegment } from '../../layout/breadcrumb.service'
import { InspectorService } from '../../layout/inspector.service'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'
import { mimeToGlyph } from '../../utils/mime-to-glyph'

@Component({
  selector: 'app-v2-trash-bin',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './trash-bin.component.html',
  styleUrl: '../files/file-browser.component.scss',
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
export class TrashBinComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient)
  private readonly route = inject(ActivatedRoute)
  private readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  private readonly filesService = inject(FilesService)
  private readonly confirmDialog = inject(ConfirmDialogService)
  private readonly toast = inject(ToastService)
  private readonly store = inject(StoreService)
  private readonly inspector = inject(InspectorService)
  private readonly destroyRef = inject(DestroyRef)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private navSubscription: Subscription | null = null

  protected readonly mimeToGlyph = mimeToGlyph
  protected readonly files = signal<FileProps[]>([])
  protected readonly loading = signal(true)
  protected readonly errorMessage = signal<string | null>(null)
  protected readonly filter = signal('')
  protected readonly menu = signal<{ file: FileProps; x: number; y: number } | null>(null)

  protected readonly alias = toSignal(this.route.params, { initialValue: {} as { alias?: string } })
  protected readonly pathSegments = toSignal(this.route.url, { initialValue: [] })

  protected readonly folderLabel = computed(() => {
    const segs = this.pathSegments()
    if (segs.length === 0) return this.currentAlias()
    return segs[segs.length - 1].path
  })

  protected readonly filteredFiles = computed(() => {
    const q = this.filter().toLowerCase().trim()
    const items = this.files()
    if (!q) return items
    return items.filter((f) => f.name.toLowerCase().includes(q))
  })

  protected readonly totalSize = computed(() => this.files().reduce((s, f) => s + (f.isDir ? 0 : f.size), 0))

  protected readonly atBinRoot = computed(() => this.pathSegments().length === 0)

  protected readonly menuItems = computed<ContextMenuItem[]>(() => {
    const entry = this.menu()
    if (!entry) return []
    const f = entry.file
    return [
      {
        id: 'delete-permanently',
        label: 'Delete permanently',
        icon: 'trash',
        kind: 'danger',
        action: () => this.confirmAndDeletePermanently(f)
      }
    ]
  })

  ngOnInit(): void {
    // Trash rows act as direct links (click → open) and the only
    // available action is permanent-delete from the row menu — there's
    // no single-row selection state for the dock panel to read against.
    // Leave the inspector unavailable so the top bar hides its toggle.
    this.inspector.clear()
    this.navSubscription = combineLatest([this.route.params, this.route.url]).subscribe(() => {
      this.syncBreadcrumbs()
      this.loadFiles()
    })
    // Refresh on each completed task affecting this folder, not just when the
    // active queue empties — a single hung task would otherwise prevent any
    // refresh from firing. Mirrors classic spaces-browser's filesOnEvent reload.
    this.store.filesOnEvent
      .pipe(
        filter((ev: FileEvent | null) => {
          if (!ev) return false
          const here = this.currentFolderRoute()
          return ev.filePath === here || ev.fileDstPath === here
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(() => this.refresh())
  }

  private currentFolderRoute(): string {
    const alias = this.currentAlias()
    if (!alias) return ''
    const segs = this.pathSegments().map((s) => s.path)
    return [SPACE_REPOSITORY.TRASH, alias, ...segs].join('/')
  }

  ngOnDestroy(): void {
    this.navSubscription?.unsubscribe()
    this.inspector.clear()
  }

  protected refresh(): void {
    this.loadFiles()
  }

  protected openEntry(file: FileProps): void {
    const alias = this.currentAlias()
    if (!alias) return
    if (file.isDir) {
      const segs = this.pathSegments().map((s) => s.path)
      this.router.navigate(['/', V2_PATH, V2_ROUTES.TRASH, alias, ...segs, file.name]).catch(console.error)
    }
    // Non-directory entries in trash are not openable for preview — the paths
    // live under /trash, which the v2 viewer/file-detail don't route into.
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

  protected async confirmAndDeletePermanently(file: FileProps): Promise<void> {
    const ok = await this.confirmDialog.open({
      title: 'Delete permanently',
      message: 'v2_delete_permanently_one',
      messageParams: { name: file.name },
      confirmLabel: 'Delete permanently',
      kind: 'danger'
    })
    if (!ok) return
    this.filesService.delete([this.buildFileStub(file)])
    this.toast.success('v2_deleting_one_progress', { name: file.name })
  }

  protected async confirmAndEmptyTrash(): Promise<void> {
    const items = this.files()
    if (items.length === 0) return
    const ok = await this.confirmDialog.open({
      title: 'Empty trash',
      message: 'v2_empty_trash',
      messageParams: { nb: items.length },
      confirmLabel: 'Empty trash',
      kind: 'danger'
    })
    if (!ok) return
    this.filesService.delete(items.map((f) => this.buildFileStub(f)))
    this.toast.success('v2_emptying_trash_progress')
  }

  private buildFileStub(file: FileProps): FileModel {
    const fullPath = buildSpaceFilePath(
      SPACE_REPOSITORY.TRASH,
      this.currentAlias(),
      this.pathSegments().map((s) => s.path),
      file.name
    )
    return buildFileModelStub(file, fullPath)
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
    const url = [API_SPACES_BROWSE, SPACE_REPOSITORY.TRASH, alias, ...segs].join('/')
    this.http.get<SpaceFiles>(url).subscribe({
      next: (result) => {
        this.files.set(result.files)
        this.loading.set(false)
      },
      error: (e: HttpErrorResponse) => {
        this.files.set([])
        this.errorMessage.set(e.status === 404 ? 'Folder not found' : 'Failed to load trash.')
        this.loading.set(false)
      }
    })
  }

  private syncBreadcrumbs(): void {
    const alias = this.currentAlias()
    if (!alias) return
    const segs = this.pathSegments().map((s) => s.path)
    const trashIndex: BreadcrumbSegment = {
      label: 'Trash',
      icon: 'trash',
      route: ['/', V2_PATH, V2_ROUTES.TRASH]
    }
    const root: BreadcrumbSegment = {
      label: alias,
      route: ['/', V2_PATH, V2_ROUTES.TRASH, alias]
    }
    const trail: BreadcrumbSegment[] = segs.map((seg, i) => ({
      label: seg,
      route: ['/', V2_PATH, V2_ROUTES.TRASH, alias, ...segs.slice(0, i + 1)]
    }))
    this.breadcrumbs.setBreadcrumbs([trashIndex, root, ...trail])
  }
}
