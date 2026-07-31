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
  untracked,
  viewChild
} from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { ActivatedRoute, Router } from '@angular/router'
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { API_FILES_OPERATION } from '@sync-in-server/backend/src/applications/files/constants/routes'
import { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { API_SPACES_BROWSE } from '@sync-in-server/backend/src/applications/spaces/constants/routes'
import { SPACE_ALIAS } from '@sync-in-server/backend/src/applications/spaces/constants/spaces'
import { ShareDialogService } from '../../components/share-dialog.service'
import { SpaceFiles } from '@sync-in-server/backend/src/applications/spaces/interfaces/space-files.interface'
import { encodeUrl } from '@sync-in-server/backend/src/common/shared'
import { ToBytesPipe } from '../../../../common/pipes/to-bytes.pipe'
import { TimeAgoPipe } from '../../../../common/pipes/time-ago.pipe'
import { ButtonComponent } from '../../components/button.component'
import { CommentsPanelComponent } from '../../components/comments-panel.component'
import { VersionsPanelComponent } from '../../components/versions-panel.component'
import { VersionsService } from '../../services/versions.service'
import { FileGlyphComponent } from '../../components/file-glyph.component'
import { IconButtonComponent } from '../../components/icon-button.component'
import { IconV2Component, IconV2Name } from '../../icons/icon-v2.component'
import { BreadcrumbSegment, V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { LayoutV2Service } from '../../layout/layout-v2.service'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'
import { isTextEditable, isDiagramExt } from '../../utils/classify-file'
import { isFileWriteable } from '../../utils/file-writeable'
import { isAudioMime, isImageMime, isMarkdownMime, isPdfMime, isTextViewerMime, isVideoMime, mimeLabel, mimeToGlyph } from '../../utils/mime-to-glyph'
import { isOfficeEditorEnabled, isOfficeExtension } from '../../utils/office'
import { assetsUrl } from '../../../files/files.constants'
import { OfficeViewComponent } from '../../preview/office-view.component'
import { TextCodeViewComponent } from '../../preview/text-code-view.component'
import { MarkdownViewComponent } from '../../preview/markdown-view.component'
import { DiagramViewComponent } from '../../preview/diagram-view.component'
import { CloseGuardService } from '../../preview/close-guard.service'
import { StoreService } from '../../../../store/store.service'

type InspectorTab = 'info' | 'comment' | 'versions' | 'activity' | 'share'

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
    VersionsPanelComponent,
    OfficeViewComponent,
    TextCodeViewComponent,
    MarkdownViewComponent,
    DiagramViewComponent,
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
  private readonly sanitizer = inject(DomSanitizer)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  private readonly closeGuard = inject(CloseGuardService)
  private readonly shareDialog = inject(ShareDialogService)
  private readonly destroyRef = inject(DestroyRef)
  private readonly layoutV2 = inject(LayoutV2Service)
  private readonly store = inject(StoreService)
  private readonly versions = inject(VersionsService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private readonly pdfjsViewerUrl = `${assetsUrl}/pdfjs/web/viewer.html?file=`
  private readonly imageEl = viewChild<ElementRef<HTMLImageElement>>('imageEl')
  private readonly diagramView = viewChild(DiagramViewComponent)

  protected readonly mimeToGlyph = mimeToGlyph
  protected readonly file = signal<FileProps | null>(null)
  // The parent folder's permission string, from the same browse response the file
  // row comes from. It was already being fetched and thrown away, which is how the
  // text and markdown editors came to mount with no permission check at all (#372).
  protected readonly permissions = signal<string>('')
  protected readonly currentPath = signal<string>('')
  protected readonly parentPath = signal<string>('')
  protected readonly siblings = signal<FileProps[]>([])
  protected readonly loading = signal(true)
  protected readonly errorMessage = signal<string | null>(null)
  protected readonly loadError = signal<string | null>(null)
  protected readonly resolution = signal<string>('')
  protected readonly tab = signal<InspectorTab>('info')
  protected readonly infoOpen = signal(false)
  protected readonly pdfStage = signal<'pdf' | 'office'>('pdf')

  // Every tab this screen can address, including ones not currently shown —
  // `?tab=` is validated against this, so a deep link survives a tab that is
  // still resolving its availability.
  private readonly allTabs: TabDef[] = [
    { id: 'info', label: 'Info', icon: 'info' },
    { id: 'comment', label: 'Comments', icon: 'comment' },
    { id: 'versions', label: 'Versions', icon: 'clock' },
    { id: 'activity', label: 'Activity', icon: 'activity' },
    { id: 'share', label: 'Sharing', icon: 'shareTree' }
  ]

  // Versions is hidden until the server has confirmed the feature exists (it is
  // off by default and env-only, so there is nothing to ask but the API itself)
  // and never applies to a directory. Hidden rather than disabled: a tab for a
  // feature this server does not have is noise, not information.
  protected readonly tabs = computed<TabDef[]>(() => {
    const show = this.versions.availability() === 'available' && !!this.file() && !this.file()!.isDir
    return show ? this.allTabs : this.allTabs.filter((t) => t.id !== 'versions')
  })

  protected readonly glyphType = computed(() => {
    const f = this.file()
    if (!f) return 'default' as const
    return f.isDir ? 'folder' : mimeToGlyph(f.mime)
  })

  // Exposed to the template so the three places that used to print the raw
  // stored mime can show a human label instead, keeping the machine string in
  // a title attribute for anyone who wants it.
  protected readonly mimeLabel = mimeLabel

  protected readonly previewUrl = computed(() => {
    const p = this.currentPath()
    return p ? `${API_FILES_OPERATION}/${encodeUrl(p)}` : ''
  })

  protected readonly pdfSafeUrl = computed<SafeResourceUrl | null>(() => {
    const p = this.currentPath()
    if (!p || !this.isPdf()) return null
    return this.sanitizer.bypassSecurityTrustResourceUrl(`${this.pdfjsViewerUrl}${API_FILES_OPERATION}/${encodeUrl(p)}`)
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
  // An office editor being *configured* is half the gate — the other half is the
  // extension. Classic couples them the same way (file.model.ts:189-191); v2 had
  // only the extension half, so on a server with no office editor a .docx still
  // mounted the embed and dead-ended on "editor not available" (#307).
  protected readonly officeEditorEnabled = computed(() => isOfficeEditorEnabled(this.store.server().files.editors))
  protected readonly isOffice = computed(() => {
    const f = this.file()
    return !!f && !isPdfMime(f.mime) && isOfficeExtension(f.name) && this.officeEditorEnabled()
  })
  protected readonly isMarkdown = computed(() => {
    const f = this.file()
    return !!f && !f.isDir && isMarkdownMime(f.mime, f.name) && isTextEditable(f)
  })
  protected readonly isText = computed(() => {
    const f = this.file()
    if (!f || this.isMarkdown()) return false
    return isTextViewerMime(f.mime) && isTextEditable(f)
  })
  protected readonly isVideo = computed(() => isVideoMime(this.file()?.mime))
  protected readonly isAudio = computed(() => isAudioMime(this.file()?.mime))
  protected readonly isDiagram = computed(() => {
    const f = this.file()
    return !!f && !f.isDir && isDiagramExt(f.name)
  })

  protected readonly diagramPath = computed(() => this.currentPath())
  protected readonly showOfficeEmbed = computed(() => this.isOffice() || (this.isPdf() && this.pdfStage() === 'office'))
  // Same gate from the other end: a PDF is only "editable" when an office editor
  // is enabled (classic file.model.ts:185), so without one the toggle that mounts
  // the embed must not be offered either. `showOfficeEmbed` reaches the embed for
  // a PDF solely through `pdfStage`, which only `toggleToOffice` ever advances.
  protected readonly canToggleToOffice = computed(() => !!this.file() && this.isPdf() && this.officeEditorEnabled())
  protected readonly commentsAvailable = computed(() => {
    const f = this.file()
    return !!f && !f.isDir
  })

  protected readonly canShare = computed(() => {
    const parts = this.currentPath().split('/').filter(Boolean)
    const alias = parts[1] ?? ''
    return !!this.file() && alias !== SPACE_ALIAS.TRASH && alias !== SPACE_ALIAS.SHARES
  })

  // Whether the embedded text / markdown editors may offer editing. The shared
  // contract does the permission and lock test (utils/file-writeable.ts); the
  // repository-level narrowing is this caller's job, exactly as it is in classic —
  // SpacesBrowserComponent.openViewerDialog passes '' for a trash file before the
  // MODIFY test ever runs, because a deleted file is not editable in place. No v2
  // screen currently navigates here with a trash path, so this is a guard against a
  // hand-typed one rather than a live route.
  protected readonly fileWriteable = computed(() => {
    const alias = this.currentPath().split('/').filter(Boolean)[1] ?? ''
    if (alias === SPACE_ALIAS.TRASH) return false
    return isFileWriteable(this.file(), this.permissions())
  })

  constructor() {
    // Auto-collapse the desktop sidebar while an office or diagram editor is
    // mounted; restore the user's prior collapse state on leave. The signal
    // writes go through untracked() per the LayoutV2Service contract — the
    // effect itself only reads isOffice/isDiagram, so the writes don't
    // re-trigger it.
    effect(() => {
      const inEditor = this.isOffice() || this.isDiagram()
      untracked(() => {
        if (inEditor) this.layoutV2.beginAutoCollapse()
        else this.layoutV2.endAutoCollapse()
      })
    })
    this.destroyRef.onDestroy(() => this.layoutV2.endAutoCollapse())
  }

  @HostListener('window:keydown', ['$event'])
  onKey(ev: KeyboardEvent): void {
    const target = ev.target as HTMLElement
    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable) return
    if (ev.key === 'ArrowRight') {
      this.next()
      ev.preventDefault()
    } else if (ev.key === 'ArrowLeft') {
      this.previous()
      ev.preventDefault()
    } else if (ev.key === 'Escape') {
      ev.preventDefault()
      void this.close()
    }
  }

  ngOnInit(): void {
    this.layoutV2.setDock(null)
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const path = params.get('path')
      if (!path) {
        this.errorMessage.set('No file path supplied.')
        this.loading.set(false)
        return
      }
      const tab = params.get('tab') as InspectorTab | null
      if (tab && this.allTabs.some((t) => t.id === tab)) {
        this.tab.set(tab)
        this.infoOpen.set(true)
      }
      this.loadFile(path)
    })
  }

  protected setTab(t: InspectorTab): void {
    this.tab.set(t)
  }

  protected toggleInfo(): void {
    this.infoOpen.update((v) => !v)
  }

  protected toggleToOffice(): void {
    this.pdfStage.update((s) => (s === 'pdf' ? 'office' : 'pdf'))
  }

  // "Edit in OnlyOffice" / "Edit in Euro-Office" depending on the enabled
  // provider — mirrors classic FilesViewerDialogComponent.editOfficeEditorText.
  protected get editOfficeEditorText(): string {
    return this.store.server().files.editors.onlyoffice ? 'Edit in OnlyOffice' : 'Edit in Euro-Office'
  }

  protected fullscreen(): void {
    this.imageEl()?.nativeElement.requestFullscreen().catch(console.error)
  }

  protected onHasCommentsChange(has: boolean): void {
    const f = this.file()
    if (!f) return
    if (!!f.hasComments === has) return
    this.file.set({ ...f, hasComments: has })
  }

  // A restore rewrote the live file, so its size, mtime and rendered content are
  // all stale. Reloading the path is the same work the screen does on entry, and
  // cheaper to reason about than patching each stale field.
  protected onVersionRestored(): void {
    const path = this.currentPath()
    if (path) this.loadFile(path)
  }

  protected onImageLoad(): void {
    const img = this.imageEl()?.nativeElement
    if (img) this.resolution.set(`${img.naturalWidth} × ${img.naturalHeight}`)
    this.loadError.set(null)
  }

  protected onImageError(): void {
    this.loadError.set('Failed to load image.')
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

  protected async close(): Promise<void> {
    const ok = await this.closeGuard.canClose()
    if (!ok) return
    if (window.history.length > 1) {
      window.history.back()
    } else {
      this.router.navigate(['/', V2_PATH, V2_ROUTES.RECENTS]).catch(console.error)
    }
  }

  protected download(): void {
    const p = this.currentPath()
    if (!p || typeof window === 'undefined') return
    window.open(`${API_FILES_OPERATION}/${encodeUrl(p)}`, '_self')
  }

  protected print(): void {
    // Diagram print is routed through the parent (this) because drawio's own
    // PrintDialog uses a popup that Firefox refuses to render from a cross-
    // origin iframe. See DiagramViewComponent.requestPrint.
    this.diagramView()?.requestPrint()
  }

  protected async openShare(): Promise<void> {
    const f = this.file()
    if (!f) return
    const parts = this.currentPath().split('/').filter(Boolean)
    const alias = parts[1] ?? ''
    const relativePath = parts.slice(2).join('/')
    await this.shareDialog.open({
      file: {
        id: f.id,
        name: f.name,
        isDir: f.isDir,
        mime: f.mime,
        space: { alias, name: alias, root: { alias, name: alias } } as never
      },
      relativePath,
      ownerId: null
    })
  }

  private goTo(path: string): void {
    this.pdfStage.set('pdf')
    this.resolution.set('')
    this.loadError.set(null)
    this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: { path }, replaceUrl: true }).catch(console.error)
  }

  // Derive the correct root breadcrumb from the file path so the trail reads
  // "Personal → file.txt" for personal files and "myspace → file.txt" for
  // space files, instead of always showing "Personal".
  private rootBreadcrumb(path: string): BreadcrumbSegment[] {
    const alias = path.split('/').filter(Boolean)[1] ?? ''
    if (alias === SPACE_ALIAS.PERSONAL) return [{ label: 'Personal', icon: 'folder', route: ['/', V2_PATH, V2_ROUTES.PERSONAL] }]
    if (alias === SPACE_ALIAS.TRASH) return [{ label: 'Trash', route: ['/', V2_PATH, V2_ROUTES.TRASH] }]
    if (alias === SPACE_ALIAS.SHARES) return [{ label: 'Shared', route: ['/', V2_PATH, V2_ROUTES.SHARED] }]
    if (alias) return [{ label: alias, icon: 'folder', route: ['/', V2_PATH, V2_ROUTES.SPACES, alias] }]
    return []
  }

  // Intermediate folders between the root and the file itself, each linking
  // back to the folder browser at that depth. Personal and space routes both
  // have wildcard children that accept arbitrary subpaths; trash/shares don't
  // expose a folder-browse view, so their intermediates stay non-navigable.
  private folderTrail(path: string): BreadcrumbSegment[] {
    const parts = path.split('/').filter(Boolean)
    const alias = parts[1] ?? ''
    const segs = parts.slice(2, -1)
    if (segs.length === 0) return []
    if (alias === SPACE_ALIAS.PERSONAL) {
      return segs.map((seg, i) => ({
        label: seg,
        route: ['/', V2_PATH, V2_ROUTES.PERSONAL, ...segs.slice(0, i + 1)]
      }))
    }
    if (alias && alias !== SPACE_ALIAS.TRASH && alias !== SPACE_ALIAS.SHARES) {
      return segs.map((seg, i) => ({
        label: seg,
        route: ['/', V2_PATH, V2_ROUTES.SPACES, alias, ...segs.slice(0, i + 1)]
      }))
    }
    return segs.map((seg) => ({ label: seg }))
  }

  private loadFile(path: string): void {
    this.loading.set(true)
    this.errorMessage.set(null)
    this.pdfStage.set('pdf')
    this.resolution.set('')
    this.loadError.set(null)
    // Cleared, not left stale: a failed or still-pending browse must not let the
    // previous folder's grant decide whether this file is editable.
    this.permissions.set('')
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
          this.permissions.set(result.permissions ?? '')
          this.siblings.set(result.files.filter((f) => !f.isDir))
          this.loading.set(false)
          this.breadcrumbs.setBreadcrumbs([...this.rootBreadcrumb(path), ...this.folderTrail(path), { label: match.name }])
          // Settles whether to offer the Versions tab. No-ops after the first
          // answer of the session.
          if (!match.isDir) this.versions.probe(path)
        },
        error: (e: HttpErrorResponse) => {
          this.errorMessage.set(e.status === 403 ? 'You do not have access to this file.' : 'Failed to load file.')
          this.loading.set(false)
        }
      })
  }
}
