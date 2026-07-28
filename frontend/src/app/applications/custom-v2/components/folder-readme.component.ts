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
import { SERVER_NAME } from '@sync-in-server/backend/src/common/shared'
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
import { ButtonComponent } from './button.component'
import { ToastService } from './toast.service'

// Follows the established ui.<scope>.<setting> convention: 'ui.version'
// (v2.constants.ts:33), 'ui.personal.viewMode' (personal.component.ts:74).
const EXPANDED_STORAGE_KEY = 'ui.folderReadme.expanded'

function readStoredExpanded(): boolean {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return false
  return window.localStorage.getItem(EXPANDED_STORAGE_KEY) === 'true'
}

function writeStoredExpanded(expanded: boolean): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return
  window.localStorage.setItem(EXPANDED_STORAGE_KEY, expanded ? 'true' : 'false')
}

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
         while an unsaved save is still in flight. Only closeEditor() unmounts it. -->
    @if (visible()) {
      <section class="fr">
        <header class="fr__head">
          <!-- headerName() prefers the frozen edit target, so the name never
               announces the folder we navigated INTO while we are still editing
               the one we left. -->
          <span class="fr__name">{{ headerName() }}</span>
          <span class="fr__spacer"></span>
          @if (!editing() && writeable()) {
            <app-v2-btn kind="ghost" size="sm" icon="pencil" (click)="onEditClick()">
              {{ 'Edit' | translate: locale.language }}
            </app-v2-btn>
          }
        </header>

        @if (editing() && editTarget(); as target) {
          <div class="fr__edit">
            <app-v2-preview-markdown-view
              [path]="target.path"
              [file]="target.file"
              [isWriteable]="true"
              [inline]="true"
              (saved)="onEditorSaved()"
              (done)="onEditorDone()"
            />
          </div>
        } @else if (loadError(); as err) {
          <div class="fr__error">{{ err | translate: locale.language }}</div>
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
        /* --si-mono is the token (_tokens.scss:114). There is no
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
        /* --si-rose is v2's error colour (_tokens.scss:95, used the same way in
           action-sheet.component.ts). There is no --si-danger. */
        color: var(--si-rose, #ff6c5d);
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
        padding: 6px 0 0;
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
  // Used only to tell our own exclusive lock apart from a stranger's — see writeable().
  private readonly currentUser = toSignal(this.store.user)

  readonly dirPath = input.required<string>()
  readonly files = input.required<readonly FileProps[]>()
  readonly permissions = input.required<string>()
  // Emitted when the host listing is stale and should reload.
  readonly changed = output<void>()

  // The listing can report an exclusive lock that THIS BANNER'S OWN EDITOR took:
  // edit mode locks the readme on open, and the save-triggered refresh
  // (onEditorSaved) re-reads the row while we still hold it. Neither classic's
  // writeable contract (files.service.ts:314) nor markdown-view's copy of it
  // (markdown-view.component.ts:714) tells that lock apart from a stranger's, so
  // both go read-only on it — Save then Cancel left the banner with no Edit
  // button, and the next Edit opened a read-only editor. The backend does tell
  // them apart: the lock route goes through filesLockManager.createOrRefresh,
  // which refreshes the caller's own lock rather than conflicting
  // (files-lock-manager.service.ts:69-87). So drop it here, once.
  //
  // Narrowly gated on purpose. Stripping ANY same-owner exclusive lock was too
  // wide: markdown-view stores whatever lock() returns as stub.lock and DELETEs
  // it on destroy, so closing this editor would have deleted a lock a DIFFERENT
  // application of the same user still believed it held. Only locks created
  // through the plain API lock route carry app === SERVER_NAME
  // (files-manager.service.ts:866); WebDAV/sync-client locks carry 'WebDAV' and
  // can be exclusive, so they stay opaque and correctly render as read-only.
  // (Collabora and OnlyOffice already take SHARED locks, so isExclusive is false
  // for them and they were never in scope.)
  //
  // KNOWN LIMITATION: FileLockProps exposes only { owner, app, info, isExclusive },
  // and the API lock route passes no lock options, so `info` is always undefined
  // for a SERVER_NAME lock. Nothing in the row can distinguish THIS session from
  // another Sync-in-API session of the same user — a second v2 tab, or classic's
  // text editor. Two such tabs can therefore both edit, last write wins, and
  // closing one releases the other's lock. The same shape (app Sync-in, same
  // owner, options: null, isExclusive: true) is also taken by server-side
  // OPERATION locks: upload PATCH (files-manager.service.ts:316), upload PUT
  // (:155), download-from-url (:691), compress (:736), extract (:791), and
  // restore (custom-versioning/services/versioning.service.ts:465). Those get stripped by
  // this same logic, so clicking Edit during a concurrent re-upload of this
  // README would have the banner delete that operation's lock when it closes.
  // Bounded — short TTL, same owner, the banner holds its own refreshed lock in
  // the meantime — and accepted, but not limited to interactive editors alone.
  protected readonly readme = computed<FileProps | null>(() => {
    const file = pickFolderReadme(this.files())
    if (!file?.lock?.isExclusive) return file
    if (file.lock.app !== SERVER_NAME) return file
    const me = this.currentUser()?.id
    // Never compare two undefineds: that would strip a stranger's lock.
    if (typeof me !== 'number' || file.lock.owner?.id !== me) return file
    return { ...file, lock: undefined }
  })
  protected readonly loadError = signal<string | null>(null)

  protected readonly editing = signal(false)
  // The editor's target, CAPTURED when edit mode opens and deliberately not
  // derived from readme() while editing. This is load-bearing: dirPath can change
  // under us mid-edit (the host screens reload in place), and if the editor's
  // [path]/[file] bindings tracked readme() they would swing to the new folder's
  // file — or null — while the editor still holds unsaved content, making
  // markdown-view re-open a different file mid-teardown. Freezing the target
  // means folder navigation cannot disturb the editor; only we tear it down.
  protected readonly editTarget = signal<{ path: string; file: FileProps } | null>(null)
  // The dirPath that was current when startEdit() was called before the readme
  // had resolved — e.g. the "Folder description" menu entry creates the file and
  // asks for edit mode before the listing refresh has landed. Storing the path
  // rather than a bare boolean means a navigation in that window discards the
  // intent instead of opening the editor on the next folder's readme.
  private pendingEditDir: string | null = null
  private readonly editorView = viewChild(MarkdownViewComponent)
  private lastDirPath: string | null = null
  // Re-entrance guard for leaveEditOnNavigate: two folder changes in quick
  // succession would otherwise both find editing() still true (the first is
  // awaiting its save) and issue two uploads plus two toasts for one edit.
  private leavingEdit = false

  protected readonly expanded = signal<boolean>(readStoredExpanded())
  // True once the rendered content is taller than the collapsed cap. Drives
  // both the fade and whether the Show more control renders at all.
  protected readonly overflowing = signal(false)

  protected toggleExpanded(): void {
    const next = !this.expanded()
    this.expanded.set(next)
    writeStoredExpanded(next)
    // Collapsing restores the 30vh cap, which makes the scrollHeight/clientHeight
    // comparison meaningful again. Without this, a session that started with the
    // stored preference already expanded never measured overflow at all, so
    // collapsing once hid the toggle entirely with no way back.
    if (!next) this.measureOverflow()
  }

  // One editor for the component's lifetime, content swapped on navigation.
  // v2.routes.ts gives each browse screen a single child route entry
  // (`path: '**'`, see that file's own comment), so every in-screen folder hop —
  // root<->subfolder as much as subfolder<->subfolder — reuses the same route
  // config and the host screens reload in place (personal.component.ts:327,
  // space-files.component.ts:311) rather than being destroyed. This component and
  // its editor therefore survive every such hop; constructing a ProseMirror
  // instance per folder visit would be wasted work. The one thing that DOES
  // destroy this component is leaving the browse screen entirely — see the
  // navigation effect's caveat below.
  protected readonly editor = new Editor({
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
  })

  // The banner renders whenever there is a readme OR we are editing one. The
  // second term is load-bearing: navigating into a folder with no readme must not
  // unmount an editor that still has a save in flight for the folder we left.
  protected readonly visible = computed(() => !!this.readme() || (this.editing() && !!this.editTarget()))

  // While editing, the header names the frozen target, not whatever readme() has
  // since resolved to.
  protected readonly headerName = computed(() => this.editTarget()?.file.name ?? this.readme()?.name ?? '')

  protected readonly writeable = computed(() => {
    const file = this.readme()
    if (!file) return false
    // Classic's contract, verbatim: files.service.ts:314. readme() has already
    // stripped a lock of our own, so any lock left here is a stranger's.
    return this.permissions().includes(SPACE_OPERATION.MODIFY) && !file.lock?.isExclusive
  })

  constructor() {
    // The collapsed cap is 30vh, so a viewport height change moves clientHeight and
    // a width change reflows the content — either can make the overflow verdict
    // stale with no content swap and no toggle click to re-measure it. The browser
    // dispatches resize after it has already re-laid the page out, so this reads
    // synchronously rather than going through measureOverflow's render hook.
    const onResize = () => this.readOverflow()
    window.addEventListener('resize', onResize, { passive: true })
    this.destroyRef.onDestroy(() => window.removeEventListener('resize', onResize))

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
      if (!file || !dir) {
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
        if (this.pendingEditDir !== null) {
          const wanted = this.pendingEditDir
          this.pendingEditDir = null
          // Only honour the queued intent if we are still in the folder that
          // asked for it — otherwise it would open the editor on a stranger.
          if (wanted === dir) this.openEditor()
        }
      })
    })

    // Folder navigation between two folders that match the SAME route config
    // reloads the host screen in place (personal.component.ts:327,
    // space-files.component.ts:311) — the host is NOT destroyed, so neither is
    // this component nor the embedded editor, whose ngOnDestroy is the only thing
    // that releases the exclusive lock. CloseGuardService can't help: it's a
    // single-slot manual guard that only file-detail's close() consults, not a
    // router guard. So drop edit mode explicitly whenever dirPath changes, which
    // both releases the lock and auto-saves. See design §5.
    //
    // dirPath is derived from the route (currentUploadRoute() over toSignal(route.url))
    // while files arrives with the listing GET, so this always fires while the
    // editor is still mounted — readme() has not yet swung to the new folder.
    //
    // CAVEAT: this effect only fires for hops that reload the host screen in
    // place — every hop WITHIN one browse screen, now that v2.routes.ts gives
    // each browse screen a single route entry (`path: '**'`; design §5).
    // Leaving the browse screen entirely — sidebar navigation, Personal -> a
    // space, opening file-detail — takes a different route config, so Angular
    // destroys the host and this component with it, and this effect never runs
    // for that hop. ngOnDestroy below runs instead: it still releases the lock
    // (the embedded editor's own ngOnDestroy unlocks) but does NOT auto-save, so
    // an unsaved edit is silently discarded there, with no toast. Fixing that
    // would need a save inside MarkdownViewComponent.ngOnDestroy that must not
    // resurrect content the user just chose to discard — a maintainer call,
    // still open.
    effect(() => {
      const dir = this.dirPath()
      const previous = this.lastDirPath
      this.lastDirPath = dir
      if (previous === null || previous === dir) return
      // A queued edit intent from the folder we just left is stale.
      this.pendingEditDir = null
      // Deliberately fire-and-forget — an effect cannot await. The teardown itself
      // runs in a finally, so the catch only ever sees a toast/emit failure.
      untracked(() => void this.leaveEditOnNavigate().catch((e) => console.error('folder-readme: leaving edit mode failed', e)))
    })
  }

  // Called by the host screen (via viewChild) right after it creates a readme.
  startEdit(): void {
    if (!this.readme()) {
      this.pendingEditDir = this.dirPath()
      return
    }
    this.openEditor()
  }

  // Lets the host keep the banner mounted while an edit is in progress, so
  // typing in the filter box cannot silently discard unsaved text. `editing` is
  // protected, so the host cannot read it directly.
  isEditing(): boolean {
    return this.editing()
  }

  protected onEditClick(): void {
    this.openEditor()
  }

  private openEditor(): void {
    const file = this.readme()
    if (!file || !this.writeable()) return
    this.editTarget.set({ path: `${this.dirPath()}/${file.name}`, file })
    this.editing.set(true)
  }

  private closeEditor(): void {
    // Unmounting MarkdownViewComponent triggers its ngOnDestroy, which releases
    // the exclusive lock. Clear the frozen target so a later Edit re-captures.
    this.editing.set(false)
    this.editTarget.set(null)
  }

  protected onEditorSaved(): void {
    // uploadFileContent issues a bare HTTP request and emits no filesOnEvent
    // (files-upload.service.ts:57-64), so the listing row's size and mtime stay
    // stale until we ask the host to reload.
    this.changed.emit()
  }

  protected onEditorDone(): void {
    // Cancel path only. MarkdownViewComponent already ran its unsaved-changes
    // confirm before emitting, and here a decline CAN be honoured — nothing has
    // navigated. Contrast leaveEditOnNavigate below.
    //
    // Deliberately does NOT emit changed(): Cancel changed nothing on the server,
    // and the host's listing GET would overtake the UNLOCK that markdown-view
    // fires from its ngOnDestroy — the refreshed row would report our own lock,
    // and writeable() (classic's contract, files.service.ts:314) would hide the
    // Edit button we just returned to.
    this.closeEditor()
  }

  // Folder navigation CANNOT be cancelled: by the time dirPath changes, the host
  // screen has already reloaded. So this path must not prompt — a prompt would
  // offer a "stay" choice it cannot honour. Maintainer's ruling: auto-save the
  // pending edit, then tear down. The frozen editTarget is what makes the await
  // safe; the editor's bindings cannot shift while we do this.
  private async leaveEditOnNavigate(): Promise<void> {
    if (this.leavingEdit || !this.editing()) return
    const view = this.editorView()
    if (!view) {
      this.closeEditor()
      return
    }
    this.leavingEdit = true
    // Captured before the await: editTarget is cleared by closeEditor() below.
    const name = this.editTarget()?.file.name ?? null
    let outcome: 'clean' | 'saved' | 'failed'
    try {
      outcome = await view.saveNowIfModified()
    } catch {
      // saveNowIfModified is documented never to throw; this is here so a future
      // change to it cannot skip the unmount in the finally block.
      outcome = 'failed'
    } finally {
      // Unmounting is the one thing this path MUST do — it is what releases the
      // exclusive lock. It therefore runs before the toast and before
      // changed.emit(), and in a finally: emit() runs the host's refresh()
      // synchronously in this call stack, so a throw anywhere under it would
      // otherwise leave the editor mounted and the lock held, with leavingEdit
      // already cleared so nothing would ever retry.
      this.closeEditor()
      this.leavingEdit = false
    }
    if (outcome === 'saved') {
      if (name) this.toast.success('v2_saved_one', { name })
      this.changed.emit()
    } else if (outcome === 'failed' && name) {
      // The lock was already released above — leaking it is the bug this whole
      // path exists to prevent, and a stale exclusive lock harms every other user
      // of the folder. Losing the text is the lesser harm, and we say so plainly.
      this.toast.error('v2_readme_autosave_failed', { name })
    }
  }

  // Only the read-mode editor needs destroying here. The embedded MarkdownViewComponent
  // is Angular's to destroy, and it releases the exclusive lock in its own ngOnDestroy.
  // This is deliberately NOT an auto-save hook: Angular destroys the child BEFORE the
  // parent (measured), so by the time this runs the child's TipTap instance is already
  // gone and getEditorMarkdown() would hand back the last SAVED content — a write that
  // looks successful while silently discarding the user's edit. See the caveat on the
  // navigation effect above.
  ngOnDestroy(): void {
    if (!this.editor.isDestroyed) this.editor.destroy()
  }

  private lastLoadKey: string | null = null

  private async load(dir: string, file: FileProps, key: string): Promise<void> {
    if (key === this.lastLoadKey) return
    this.lastLoadKey = key
    this.loadError.set(null)
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
    const host = this.readHost()?.nativeElement
    if (!host) {
      this.overflowing.set(false)
      return
    }
    if (this.expanded()) return
    this.overflowing.set(host.scrollHeight > host.clientHeight + 1)
  }

  private setContent(markdown: string): void {
    if (this.editor.isDestroyed) return
    this.editor.commands.setContent(markdown, { emitUpdate: false, contentType: 'markdown' })
    this.measureOverflow()
  }
}
