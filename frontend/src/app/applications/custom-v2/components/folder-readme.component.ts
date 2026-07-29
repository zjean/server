import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  OnDestroy,
  output,
  signal,
  untracked,
  viewChild
} from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import type { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { SPACE_OPERATION } from '@sync-in-server/backend/src/applications/spaces/constants/spaces'
import { intersectPermissions, SERVER_NAME } from '@sync-in-server/backend/src/common/shared'
import { Editor } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import { TaskItem } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { TaskList } from '@tiptap/extension-task-list'
import { Markdown } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { TiptapEditorDirective } from 'ngx-tiptap'
import { firstValueFrom } from 'rxjs'
import { StoreService } from '../../../store/store.service'
import { MarkdownViewComponent } from '../preview/markdown-view.component'
import { buildFileModelStub } from '../utils/file-model-stub'
import { pickFolderReadme } from '../utils/folder-readme'
import { ReadmeEditSession, type ReadmeSaveOutcome } from '../utils/readme-edit-session'
import { ButtonComponent } from './button.component'
import { ToastService } from './toast.service'

// A folder description is prose, and prose is small. The listing already carries
// every row's size, so refusing to fetch a huge one costs no request.
//
// This is not a theoretical bound. `Readme.md` is an ordinary file: anyone with
// the modify permission on the folder — through this UI, a sync client or WebDAV —
// can make it any size they like, and every OTHER user then downloads and parses
// it on opening the folder, with no click and nothing to warn them. Upstream
// Nextcloud has the same hole (`WorkspacePlugin` reads `$file->getContent()`
// unbounded) but pays for it once, server-side; here the parse happens in each
// viewer's tab. 256 KiB is roughly forty thousand words of prose.
const FOLDER_README_MAX_BYTES = 256 * 1024

// Renders a folder's Readme.md above the file listing, like Nextcloud's Rich
// Workspaces. Detection is a pure function over the files[] the host screen
// already loaded, so this costs one content GET and no extra listing request.
// See docs/plans/2026-07-28-v2-folder-readme-design.md.
@Component({
  selector: 'app-v2-folder-readme',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TiptapEditorDirective, L10nTranslatePipe, ButtonComponent, MarkdownViewComponent],
  template: `
    <!-- visible() deliberately survives readme() going null: the edit branch below
         must NOT be torn down by a navigation into a folder that has no readme
         while an unsaved save is still in flight. Only the session's close()
         unmounts it. -->
    @if (visible()) {
      <section class="fr">
        <header class="fr__head">
          <!-- headerName() prefers the frozen edit target, so the name never
               announces the folder we navigated INTO while we are still editing
               the one we left. -->
          <span class="fr__name">{{ headerName() }}</span>
          <span class="fr__spacer"></span>
          @if (!session.editing() && writeable()) {
            <app-v2-btn kind="ghost" size="sm" icon="pencil" (click)="onEditClick()">
              {{ 'Edit' | translate: locale.language }}
            </app-v2-btn>
          }
        </header>

        @if (session.editing() && session.target(); as target) {
          <div class="fr__edit">
            <app-v2-preview-markdown-view
              [path]="target.path"
              [file]="target.file"
              [isWriteable]="true"
              [inline]="true"
              (dirtyChange)="onEditorDirty($event)"
              (saved)="onEditorSaved()"
              (done)="onEditorDone()"
            />
          </div>
        } @else if (oversized()) {
          <div class="fr__notice">{{ 'This folder description is too large to be shown here.' | translate: locale.language }}</div>
        } @else if (loadError(); as err) {
          <div class="fr__error">{{ err | translate: locale.language }}</div>
        } @else if (contentState() === 'empty') {
          <!-- Only reachable for someone who can write: visible() hides the whole
               card for an empty description otherwise. -->
          <button type="button" class="fr__placeholder" (click)="onEditClick()">
            {{ 'Add a folder description…' | translate: locale.language }}
          </button>
        } @else if (readme()) {
          <div
            #readHost
            class="fr__read v2-prose"
            [class.fr__read--collapsed]="!expanded()"
            [class.fr__read--faded]="!expanded() && overflowing()"
            [class.fr__read--expanded]="expanded()"
          >
            <tiptap-editor [editor]="editor"></tiptap-editor>
          </div>

          @if (overflowing() || expanded()) {
            <button type="button" class="fr__toggle" (click)="toggleExpanded()">
              {{ (expanded() ? 'Show less' : 'Show more') | translate: locale.language }}
            </button>
          }
        }
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .fr {
        background: var(--si-bg1);
        border: 1px solid var(--si-border);
        border-radius: 12px;
        padding: 12px 16px;
        margin-bottom: 12px;
      }
      .fr__head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }
      .fr__name {
        font-size: 12px;
        color: var(--si-fg-muted);
        /* --si-mono is the token defined in _tokens.scss. There is no
           --si-font-mono. */
        font-family: var(--si-mono, ui-monospace, monospace);
      }
      .fr__spacer {
        flex: 1 1 auto;
      }
      /* The bounded box inline mode relies on: MarkdownViewComponent's :host is
         height:100%, so it needs an ancestor with a definite height or its flex
         column collapses. */
      .fr__edit {
        height: min(60vh, 520px);
        display: flex;
        flex-direction: column;
        border: 1px solid var(--si-border);
        border-radius: 8px;
        overflow: hidden;
      }
      .fr__error {
        font-size: 13px;
        /* --si-rose is v2's error colour (_tokens.scss, used the same way in
           action-sheet.component.ts). There is no --si-danger. */
        color: var(--si-rose, #ff6c5d);
      }
      .fr__notice {
        font-size: 13px;
        color: var(--si-fg-muted);
      }
      /* Reads as prose, behaves as the Edit affordance — the header's Edit button
         is easy to miss when the card is otherwise blank. */
      .fr__placeholder {
        appearance: none;
        background: none;
        border: none;
        padding: 0;
        margin: 0;
        font: inherit;
        font-size: 14px;
        font-style: italic;
        color: var(--si-fg-muted);
        cursor: pointer;
        text-align: start;
      }
      .fr__placeholder:hover {
        color: var(--si-fg);
      }
      .fr__read ::ng-deep .ProseMirror {
        outline: none;
      }
      .fr__read {
        position: relative;
        overflow: hidden;
      }
      /* 30vh collapsed matches Nextcloud's RichWorkspace.vue. */
      .fr__read--collapsed {
        max-height: 30vh;
      }
      /* Expanded is capped at 60vh with internal scroll rather than unbounded:
         a 200-line readme would otherwise push the file list off-screen even
         after the user expanded it — the problem the collapse exists to solve.
         This is a deliberate divergence from NC (design doc §7). */
      .fr__read--expanded {
        max-height: 60vh;
        overflow-y: auto;
      }
      .fr__read--faded::after {
        content: '';
        position: absolute;
        inset-inline: 0;
        bottom: 0;
        height: 4em;
        pointer-events: none;
        background: linear-gradient(to bottom, transparent, var(--si-bg1));
      }
      .fr__toggle {
        appearance: none;
        background: none;
        border: none;
        /* 9px horizontal matches the --xs step of v2's button padding scale
           (ButtonComponent), so this control is inset like every other small
           control rather than sitting flush against the card's text edge. It also
           widens the hit area beyond the label's glyphs. */
        padding: 6px 9px 0;
        margin: 0;
        font: inherit;
        font-size: 12px;
        color: var(--si-fg-muted);
        cursor: pointer;
      }
      .fr__toggle:hover {
        color: var(--si-fg);
        text-decoration: underline;
      }
    `
  ]
})
export class FolderReadmeComponent implements OnDestroy {
  private readonly http = inject(HttpClient)
  private readonly toast = inject(ToastService)
  private readonly store = inject(StoreService)
  private readonly injector = inject(Injector)
  private readonly destroyRef = inject(DestroyRef)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  // Used only to tell our own exclusive lock apart from a stranger's — see readme().
  private readonly currentUser = toSignal(this.store.user)

  // The folder these `files` and `permissions` describe. The host publishes all
  // three in one turn (FileBrowserBase.loadedDirPath) precisely so this component
  // can compose `dirPath + row.name` without the two halves coming from different
  // folders.
  readonly dirPath = input.required<string>()
  readonly files = input.required<readonly FileProps[]>()
  readonly permissions = input.required<string>()
  // Emitted when the host listing is stale and should reload.
  readonly changed = output<void>()

  // The edit session — frozen target, queued intent, teardown ordering. Extracted
  // so the rules design §5 calls load-bearing can be unit-tested; this class
  // cannot be instantiated in the DOM-less spec harness, that one can.
  // `protected` because the template binds `session.editing()`/`session.target()`.
  protected readonly session = new ReadmeEditSession()

  private readonly rawReadme = computed<FileProps | null>(() => pickFolderReadme(this.files()))

  // The path this banner's own editor took an exclusive lock on, or null.
  //
  // Edit mode locks the readme on open, and the save-triggered refresh
  // (onEditorSaved) re-reads the row while we still hold it. Neither classic's
  // writeable contract (FilesService.openViewerAfterAvailabilityCheck) nor
  // markdown-view's copy of it tells that lock apart from a stranger's, so both go
  // read-only on it — Save then Cancel left the banner with no Edit button, and the
  // next Edit opened a read-only editor. The backend does tell them apart: the lock
  // route (FilesManager.lock) goes through filesLockManager.createOrRefresh, which
  // refreshes the caller's own lock rather than conflicting. So readme() drops it.
  //
  // Recording the PATH rather than trusting the lock's contents is what keeps that
  // drop honest. FileLockProps exposes only { owner, app, info, isExclusive }, and
  // the lock route passes no options, so `info` is always undefined: nothing in the
  // row distinguishes this session's lock from any other Sync-in-API lock of the
  // same user. And the same shape (app Sync-in, same owner, exclusive) is taken by
  // server-side OPERATION locks — upload PUT and PATCH, download-from-url, compress,
  // extract, and versioning restore all call filesLockManager.create with
  // SERVER_NAME. An earlier revision dropped ANY such lock, which meant clicking
  // Edit during a concurrent re-upload of this README had the banner DELETE that
  // operation's lock when it closed (markdown-view stores whatever lock() returns
  // and unlocks it on destroy) — losing the mutual exclusion the lock exists for,
  // mid-write. Keyed on the path we ourselves locked, none of those are touched.
  // The one case that remains indistinguishable is a second Sync-in session of the
  // same user editing the SAME file, which needs a backend change to close.
  private readonly ownedLockPath = signal<string | null>(null)

  protected readonly readme = computed<FileProps | null>(() => {
    const file = this.rawReadme()
    if (!file?.lock?.isExclusive) return file
    // WebDAV/sync-client locks carry 'WebDAV' and can be exclusive; they stay
    // opaque and correctly render as read-only. (Collabora and OnlyOffice take
    // SHARED locks, so isExclusive is false and they were never in scope.)
    if (file.lock.app !== SERVER_NAME) return file
    const me = this.currentUser()?.id
    // Never compare two undefineds: that would strip a stranger's lock.
    if (typeof me !== 'number' || file.lock.owner?.id !== me) return file
    if (this.ownedLockPath() !== `${this.dirPath()}/${file.name}`) return file
    return { ...file, lock: undefined }
  })

  // Refusing to render is decided on the RAW row, so a lock can never change the
  // verdict. Detection itself (pickFolderReadme) stays name-only on purpose: a
  // folder whose readme is too big still HAS one, and reporting otherwise would put
  // "+ New → Folder description" back in the menu, where it would fail on a file
  // that already exists.
  protected readonly oversized = computed(() => {
    const file = this.rawReadme()
    return !!file && file.size > FOLDER_README_MAX_BYTES
  })

  protected readonly loadError = signal<string | null>(null)
  // 'unloaded' until the content GET answers. Distinguished from 'empty' so a
  // folder whose description has text is never briefly treated as blank while its
  // content is still in flight.
  protected readonly contentState = signal<'unloaded' | 'empty' | 'text'>('unloaded')

  private readonly editorView = viewChild(MarkdownViewComponent)
  // Mirrors the embedded editor's modified state, pushed up by the child. A plain
  // field rather than a viewChild read because ngOnDestroy needs it AFTER Angular
  // has destroyed that child.
  private editorDirty = false

  // Not persisted, and reset on every folder change (see the navigation effect):
  // a folder always opens collapsed. An earlier revision remembered this in
  // localStorage under a single global key, which meant expanding one long readme
  // left every other folder — including two-line ones — opening "expanded" with a
  // live Show less control against content that was never clipped.
  protected readonly expanded = signal<boolean>(false)
  // True once the rendered content is taller than the collapsed cap. Drives
  // both the fade and whether the Show more control renders at all.
  protected readonly overflowing = signal(false)
  // Coalescing guard for the resize listener below — set true when a
  // measurement is scheduled, cleared once readOverflow() actually runs, so a
  // burst of native resize events schedules at most one pending measurement.
  private resizeMeasurePending = false

  protected toggleExpanded(): void {
    const next = !this.expanded()
    this.expanded.set(next)
    // Collapsing restores the 30vh cap, which makes the scrollHeight/clientHeight
    // comparison meaningful again — readOverflow() declines to measure while
    // expanded, because an uncapped element never reports overflow and the Show
    // less control would disappear.
    if (!next) this.measureOverflow()
  }

  private editorInstance: Editor | null = null

  // One editor for the component's lifetime, content swapped on navigation.
  // v2.routes.ts gives each browse screen a single child route entry
  // (`path: '**'`, see that file's own comment), so every in-screen folder hop —
  // root<->subfolder as much as subfolder<->subfolder — reuses the same route
  // config and the ONE host screen reloads in place rather than being destroyed.
  // This component and its editor therefore survive every such hop; constructing a
  // ProseMirror instance per folder visit would be wasted work. The one thing that
  // DOES destroy this component is leaving the browse screen entirely — see the
  // navigation effect's caveat below.
  //
  // Constructed on first use rather than as a field, because `new Editor()` needs a
  // document: as a field initializer it made this class impossible to instantiate
  // without a DOM, which is both the SSR convention in this codebase and what the
  // unit-test harness provides. The only readers are the template and setContent(),
  // and neither runs without a browser.
  protected get editor(): Editor {
    return (this.editorInstance ??= new Editor({
      extensions: [
        StarterKit.configure({ link: { openOnClick: false } }),
        TaskList,
        TaskItem.configure({ nested: true }),
        TableKit.configure({ table: { resizable: false } }),
        Image.configure({ allowBase64: true }),
        Markdown
      ],
      editable: false,
      content: '',
      contentType: 'markdown'
    }))
  }

  // The banner renders whenever there is a readme OR we are editing one. The
  // second term is load-bearing: navigating into a folder with no readme must not
  // unmount an editor that still has a save in flight for the folder we left.
  protected readonly visible = computed(() => {
    if (this.session.editing() && !!this.session.target()) return true
    if (!this.readme()) return false
    // Both of these have something to say even to a reader who cannot act on it.
    if (this.oversized() || this.loadError()) return true
    // An empty description is an invitation for whoever can fill it in, and pure
    // noise for everyone else. Creating one from the New menu and then clicking
    // away without typing is easy, and the menu entry hides itself afterwards — so
    // without this a stray empty file left every viewer of the folder a blank
    // bordered card with no way to get rid of it.
    if (this.contentState() === 'empty' && !this.writeable()) return false
    return true
  })

  // While editing, the header names the frozen target, not whatever readme() has
  // since resolved to.
  protected readonly headerName = computed(() => this.session.target()?.file.name ?? this.readme()?.name ?? '')

  protected readonly writeable = computed(() => {
    const file = this.readme()
    if (!file) return false
    // Nothing to edit in a file we decline to load, and handing 256 KiB+ of
    // "prose" to a WYSIWYG editor is not a kindness either.
    if (this.oversized()) return false
    // Classic's contract: SpacesBrowserComponent.openViewerDialog intersects the
    // space's permission string with the row's OWN root permissions before
    // FilesService.openViewerAfterAvailabilityCheck tests MODIFY. The browse
    // response only pre-intersects when the browsed URL is itself inside a root
    // (SpacesBrowserService via getEnvPermissions), so at a space's top level the
    // narrower per-root grant arrives on the row and has to be applied here.
    const space = this.permissions()
    const effective = file.root?.permissions ? intersectPermissions(space, file.root.permissions) : space
    // readme() has already stripped a lock of our own, so any lock left is a
    // stranger's.
    return effective.includes(SPACE_OPERATION.MODIFY) && !file.lock?.isExclusive
  })

  constructor() {
    // The collapsed cap is 30vh, so a viewport height change moves clientHeight and
    // a width change reflows the content — either can make the overflow verdict
    // stale with no content swap and no toggle click to re-measure it. Routed
    // through measureOverflow()'s afterNextRender scheduling (not a direct
    // readOverflow() call) and guarded by resizeMeasurePending so a burst of
    // native resize events — these fire continuously while a window is being
    // dragged, not just once at the end — coalesces to one pending measurement
    // instead of a forced layout read plus a possible signal write on every event.
    if (typeof window !== 'undefined') {
      const onResize = () => {
        if (this.resizeMeasurePending) return
        this.resizeMeasurePending = true
        this.measureOverflow()
      }
      window.addEventListener('resize', onResize, { passive: true })
      this.destroyRef.onDestroy(() => window.removeEventListener('resize', onResize))
    }

    // A measurement is only meaningful once #readHost exists, and setContent() —
    // the content-driven trigger — can fire while it does not: opening edit mode
    // replaces the read block with the editor, and a save there emits changed(),
    // whose listing refresh re-resolves the readme with a new mtime and reloads the
    // content. That measurement finds no host and reports "not overflowing", and
    // closing the editor would then restore a read block with no fade and no
    // toggle. So also measure whenever the element itself appears or is replaced.
    // Guarded on truthiness so the element going away is not itself a verdict.
    effect(() => {
      if (this.readHost()) untracked(() => this.measureOverflow())
    })

    effect(() => {
      const file = this.readme()
      const dir = this.dirPath()
      const tooLarge = this.oversized()
      if (!file || !dir || tooLarge) {
        untracked(() => {
          // Reset the cache key too: without this, re-entering a folder whose
          // readme is unchanged hits the early-return in load() while the
          // content has already been blanked, leaving an empty banner.
          this.lastLoadKey = null
          this.setContent('')
        })
        return
      }
      // Re-fetch when the resolved file changes identity OR content: mtime
      // moves on every save, including saves made elsewhere.
      const key = `${file.id}:${file.mtime}`
      untracked(() => {
        this.load(dir, file, key)
        // A queued intent only fires in the folder that asked for it — the session
        // discards it on any folder change.
        if (this.session.takeQueued(dir)) this.openEditor()
      })
    })

    // Releases the owned-lock note once the server agrees the lock is gone, so the
    // drop in readme() covers only the window it exists for. Deliberately not on
    // close: the Cancel path emits no changed(), so the listing still carries our
    // lock at that moment and dropping the note there would hide the Edit button we
    // just returned to. Skipped entirely while editing, when the lock is ours by
    // construction.
    effect(() => {
      const owned = this.ownedLockPath()
      if (!owned || this.session.editing()) return
      const file = this.rawReadme()
      const stillOurs = !!file?.lock && `${this.dirPath()}/${file.name}` === owned
      if (!stillOurs) untracked(() => this.ownedLockPath.set(null))
    })

    // Folder navigation between two folders that match the SAME route config
    // reloads the host screen in place (FileBrowserBase re-runs loadFiles() on each
    // navigation emission) — the host is NOT destroyed, so neither is this
    // component nor the embedded editor, whose ngOnDestroy is the only thing that
    // releases the exclusive lock. CloseGuardService can't help: it's a single-slot
    // manual guard that only file-detail's close() consults, not a router guard. So
    // drop edit mode explicitly whenever dirPath changes, which both releases the
    // lock and auto-saves. See design §5.
    //
    // dirPath now arrives WITH the listing rather than with the route, so this runs
    // one round trip later than it used to — still while the editor is mounted,
    // because only the session's close() unmounts it. The first transition after
    // startup is from the empty initial path and is a no-op.
    //
    // CAVEAT: this effect only fires for hops that reload the host screen in
    // place — every hop WITHIN one browse screen, now that v2.routes.ts gives
    // each browse screen a single route entry (`path: '**'`; design §5).
    // Leaving the browse screen entirely — sidebar navigation, Personal -> a
    // space, opening file-detail — takes a different route config, so Angular
    // destroys the host and this component with it, and this effect never runs
    // for that hop. ngOnDestroy below runs instead: it releases the lock (the
    // embedded editor's own ngOnDestroy unlocks) and reports the discard, but
    // cannot save — see its comment.
    effect(() => {
      const dir = this.dirPath()
      if (!this.session.noteDir(dir)) return
      // Every folder opens collapsed. The host screens reload in place on an
      // in-screen hop, so this component survives and would otherwise carry the
      // previous folder's expanded state into the next one. Reset before the new
      // content loads, so setContent()'s measurement runs against the 30vh cap
      // and decides the fade and the Show more control on this folder's own
      // content. (Cross-screen hops destroy the component, so they start
      // collapsed for free.)
      this.expanded.set(false)
      // Deliberately fire-and-forget — an effect cannot await. The teardown itself
      // runs in a finally inside the session, so the catch only ever sees a toast
      // failure.
      untracked(() => void this.leaveEditOnNavigate().catch((e) => console.error('folder-readme: leaving edit mode failed', e)))
    })
  }

  // Called by the host screen (via viewChild) right after it creates a readme.
  startEdit(): void {
    if (!this.readme()) {
      this.session.queue(this.dirPath())
      return
    }
    this.openEditor()
  }

  // Lets the host keep the banner mounted while an edit is in progress, so
  // typing in the filter box cannot silently discard unsaved text.
  isEditing(): boolean {
    return this.session.editing()
  }

  protected onEditClick(): void {
    this.openEditor()
  }

  protected onEditorDirty(dirty: boolean): void {
    this.editorDirty = dirty
  }

  private openEditor(): void {
    const file = this.readme()
    if (!file || !this.writeable()) return
    const path = `${this.dirPath()}/${file.name}`
    this.editorDirty = false
    // Marked before the child takes the lock, because the child owns that call and
    // this is the last point at which we know the intent is ours. A lock request
    // that then FAILS is a same-user conflict by definition — a stranger's lock
    // carries a different owner and is never dropped by readme().
    this.ownedLockPath.set(path)
    this.session.open({ path, file })
  }

  protected onEditorSaved(): void {
    // uploadFileContent issues a bare HTTP request and emits no filesOnEvent, so
    // the listing row's size and mtime stay stale until we ask the host to reload.
    this.changed.emit()
  }

  protected onEditorDone(): void {
    // Cancel path only. MarkdownViewComponent already ran its unsaved-changes
    // confirm before emitting, and here a decline CAN be honoured — nothing has
    // navigated. Contrast leaveEditOnNavigate below.
    //
    // Deliberately does NOT emit changed(): Cancel changed nothing on the server,
    // and the host's listing GET would overtake the UNLOCK that markdown-view
    // fires from its ngOnDestroy — the refreshed row would report our own lock, and
    // writeable() would hide the Edit button we just returned to.
    this.editorDirty = false
    this.session.close()
  }

  private async leaveEditOnNavigate(): Promise<void> {
    const view = this.editorView()
    // No view means nothing to save; going through leave() anyway keeps the
    // re-entrance guard and the unmount on one path.
    const save = view ? () => view.saveNowIfModified() : async (): Promise<ReadmeSaveOutcome> => 'clean'
    const result = await this.session.leave(save)
    if (!result) return
    this.editorDirty = false
    if (result.outcome === 'saved') {
      if (result.name) this.toast.success('v2_saved_one', { name: result.name })
      // Deliberately no changed.emit() here. The save landed in the folder we
      // LEFT; dirPath has already moved on, so a refresh would re-fetch the folder
      // we are now in — which the host's own navigation subscription is already
      // doing — and would never refresh the row that actually changed. On the
      // filter-active path this component has also already been unmounted, so the
      // emit only logs "Unexpected emit for destroyed OutputRef".
    } else if (result.outcome === 'failed' && result.name) {
      // The lock was already released — leaking it is the bug this whole path
      // exists to prevent, and a stale exclusive lock harms every other user of the
      // folder. Losing the text is the lesser harm, and we say so plainly.
      this.toast.error('v2_readme_autosave_failed', { name: result.name })
    }
  }

  ngOnDestroy(): void {
    // Only the read-mode editor is ours to destroy. The embedded MarkdownViewComponent
    // is Angular's, and it releases the exclusive lock in its own ngOnDestroy.
    if (this.editorInstance && !this.editorInstance.isDestroyed) this.editorInstance.destroy()
    // This is deliberately NOT an auto-save hook: Angular destroys the child BEFORE
    // the parent (measured), so by the time this runs the child's TipTap instance is
    // gone and its serializer would hand back the last SAVED content — a write that
    // looks successful while silently discarding the user's edit.
    //
    // But saying nothing was its own defect. This is the ordinary way to leave —
    // the sidebar, Personal -> a space, opening a file — and the navigation effect
    // never runs for it, so unsaved text went with no signal at all, which is
    // indistinguishable from the app losing data at random. We cannot save it; we
    // can at least say so, from the dirty flag the child pushed up while alive.
    if (this.session.editing() && this.editorDirty) {
      const name = this.session.target()?.file.name
      if (name) this.toast.error('v2_readme_discarded', { name })
    }
  }

  private lastLoadKey: string | null = null

  private async load(dir: string, file: FileProps, key: string): Promise<void> {
    if (key === this.lastLoadKey) return
    this.lastLoadKey = key
    this.loadError.set(null)
    this.contentState.set('unloaded')
    const stub = buildFileModelStub(file, `${dir}/${file.name}`)
    try {
      const text = await firstValueFrom(this.http.get(stub.dataUrl, { responseType: 'text' }))
      // Superseded while in flight — a newer folder's load already owns the view.
      if (this.lastLoadKey !== key) return
      this.setContent(text ?? '')
    } catch (e) {
      if (this.lastLoadKey !== key) return
      const err = e as HttpErrorResponse
      this.setContent('')
      this.loadError.set(err?.error?.message ?? err?.statusText ?? 'Failed to load folder description')
    }
  }

  private readonly readHost = viewChild<ElementRef<HTMLElement>>('readHost')

  // Defers the read until Angular has actually rendered, because #readHost lives
  // inside `@else if (readme())` nested in `@if (visible())` and may not exist yet
  // when setContent() runs.
  //
  // This was a bare requestAnimationFrame and that is what broke the feature:
  // rAF callbacks are serviced by the browser's "update the rendering" steps, and
  // a page whose rendering lifecycle is not running — a background/hidden tab, an
  // occluded window, headless Chromium — never runs them. The single frame then
  // never arrived, measureOverflow()'s guard was never reached at all, overflowing
  // stayed at its initial false, and every consumer of it (the fade, the toggle)
  // was dead with no error. afterNextRender does not depend on frame production:
  // Angular's change-detection scheduler races requestAnimationFrame against
  // setTimeout and takes whichever fires first, and registering a render hook
  // notifies that scheduler, so the callback runs on the timer path when no frames
  // are being produced. Measured: it lands ~1ms after the call, in the same task.
  //
  // The `read` phase is the one Angular reserves for layout reads.
  private measureOverflow(): void {
    afterNextRender({ read: () => this.readOverflow() }, { injector: this.injector })
  }

  // scrollHeight exceeds clientHeight only while the collapsed cap is actually
  // clipping, so this is only measurable in the collapsed state — when expanded,
  // keep the previous verdict rather than measuring an uncapped element and
  // concluding "not overflowing", which would hide the Show less control.
  private readOverflow(): void {
    this.resizeMeasurePending = false
    const host = this.readHost()?.nativeElement
    if (!host) {
      this.overflowing.set(false)
      return
    }
    if (this.expanded()) return
    this.overflowing.set(host.scrollHeight > host.clientHeight + 1)
  }

  private setContent(markdown: string): void {
    this.contentState.set(markdown.trim() ? 'text' : 'empty')
    // Nothing to blank if the editor was never built, and building one in order to
    // set it to '' would construct a ProseMirror instance for every folder that has
    // no description at all — which is most of them. Skipping the measurement here
    // is safe: with no content there is no read block to clip, and the readHost
    // effect measures again as soon as one appears.
    if (!this.editorInstance && !markdown) return
    if (this.editorInstance?.isDestroyed) return
    this.editor.commands.setContent(markdown, { emitUpdate: false, contentType: 'markdown' })
    this.measureOverflow()
  }
}
