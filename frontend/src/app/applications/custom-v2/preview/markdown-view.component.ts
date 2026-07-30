import { CodeEditor } from '@acrodata/code-editor'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, HostListener, OnDestroy, OnInit, effect, inject, input, output, signal, untracked } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { Editor } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import { TaskItem } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { TaskList } from '@tiptap/extension-task-list'
import { Markdown } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import type { FileLockProps, FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { TiptapEditorDirective } from 'ngx-tiptap'
import { firstValueFrom } from 'rxjs'
import { themeDark } from '../../../layout/layout.interfaces'
import { LayoutService } from '../../../layout/layout.service'
import { fileLockPropsToString } from '../../files/components/utils/file-lock.utils'
import { FileModel } from '../../files/models/file.model'
import { FilesService } from '../../files/services/files.service'
import { FilesUploadService } from '../../files/services/files-upload.service'
import { ButtonComponent } from '../components/button.component'
import { ConfirmDialogService } from '../components/confirm-dialog.service'
import { IconButtonComponent } from '../components/icon-button.component'
import { ToastService } from '../components/toast.service'
import { buildFileModelStub } from '../utils/file-model-stub'
import { CloseGuardService } from './close-guard.service'

type EditorTheme = 'light' | 'dark'
type HeadingLevel = 1 | 2 | 3
type InlineMark = 'bold' | 'italic' | 'strike' | 'code'

// Markdown viewer/editor for v2. TipTap WYSIWYG with a source-mode fallback
// (CodeMirror) for users who need raw markdown. Mirrors text-code-view's
// load/lock/save lifecycle and close-guard registration. Lives in the unified
// preview shell — no modal trappings.
@Component({
  selector: 'app-v2-preview-markdown-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CodeEditor, FormsModule, TiptapEditorDirective, ButtonComponent, IconButtonComponent, L10nTranslatePipe],
  template: `
    <div class="md-view" [class.md-view--inline]="inline()">
      <header class="md-view__head">
        <span class="md-view__status">
          @if (loading()) {
            {{ 'Loading…' | translate: locale.language }}
          } @else if (saving()) {
            {{ 'Saving…' | translate: locale.language }}
          } @else if (isModified()) {
            {{ 'Modified' | translate: locale.language }}
          } @else if (lockOwner()) {
            {{ 'Read-only' | translate: locale.language }} ({{ lockOwner() }})
          } @else if (!writeable()) {
            {{ 'Read-only' | translate: locale.language }}
          } @else {
            {{ 'Saved' | translate: locale.language }}
          }
        </span>

        @if (!loading() && canEditVisual()) {
          <nav class="md-view__toolbar" role="toolbar" [attr.aria-label]="'Formatting' | translate: locale.language">
            <button
              type="button"
              class="md-tool md-tool--text"
              [class.md-tool--active]="isActive('heading', { level: 1 })"
              [attr.title]="'Heading 1' | translate: locale.language"
              (click)="toggleHeading(1)"
            >
              H1
            </button>
            <button
              type="button"
              class="md-tool md-tool--text"
              [class.md-tool--active]="isActive('heading', { level: 2 })"
              [attr.title]="'Heading 2' | translate: locale.language"
              (click)="toggleHeading(2)"
            >
              H2
            </button>
            <button
              type="button"
              class="md-tool md-tool--text"
              [class.md-tool--active]="isActive('heading', { level: 3 })"
              [attr.title]="'Heading 3' | translate: locale.language"
              (click)="toggleHeading(3)"
            >
              H3
            </button>
            <span class="md-tool__sep"></span>
            <button
              type="button"
              class="md-tool md-tool--text md-tool--bold"
              [class.md-tool--active]="isActive('bold')"
              [attr.title]="'Bold (Ctrl/Cmd+B)' | translate: locale.language"
              (click)="toggleMark('bold')"
            >
              B
            </button>
            <button
              type="button"
              class="md-tool md-tool--text md-tool--italic"
              [class.md-tool--active]="isActive('italic')"
              [attr.title]="'Italic (Ctrl/Cmd+I)' | translate: locale.language"
              (click)="toggleMark('italic')"
            >
              I
            </button>
            <button
              type="button"
              class="md-tool md-tool--text md-tool--strike"
              [class.md-tool--active]="isActive('strike')"
              [attr.title]="'Strikethrough' | translate: locale.language"
              (click)="toggleMark('strike')"
            >
              S
            </button>
            <button
              type="button"
              class="md-tool md-tool--text md-tool--mono"
              [class.md-tool--active]="isActive('code')"
              [attr.title]="'Inline code' | translate: locale.language"
              (click)="toggleMark('code')"
            >
              &lt;/&gt;
            </button>
            <span class="md-tool__sep"></span>
            <button
              type="button"
              class="md-tool md-tool--text"
              [class.md-tool--active]="isActive('bulletList')"
              [attr.title]="'Bulleted list' | translate: locale.language"
              (click)="toggleBulletList()"
            >
              &bull;
            </button>
            <button
              type="button"
              class="md-tool md-tool--text"
              [class.md-tool--active]="isActive('orderedList')"
              [attr.title]="'Numbered list' | translate: locale.language"
              (click)="toggleOrderedList()"
            >
              1.
            </button>
            <button
              type="button"
              class="md-tool md-tool--text"
              [class.md-tool--active]="isActive('taskList')"
              [attr.title]="'Task list' | translate: locale.language"
              (click)="toggleTaskList()"
            >
              &#9744;
            </button>
            <span class="md-tool__sep"></span>
            <button
              type="button"
              class="md-tool md-tool--text"
              [class.md-tool--active]="isActive('blockquote')"
              [attr.title]="'Blockquote' | translate: locale.language"
              (click)="toggleBlockquote()"
            >
              &laquo;
            </button>
            <button
              type="button"
              class="md-tool md-tool--text md-tool--mono"
              [class.md-tool--active]="isActive('codeBlock')"
              [attr.title]="'Code block' | translate: locale.language"
              (click)="toggleCodeBlock()"
            >
              &#123;&nbsp;&#125;
            </button>
            <button
              type="button"
              class="md-tool md-tool--text"
              [class.md-tool--active]="isActive('link')"
              [attr.title]="'Link' | translate: locale.language"
              (click)="setLink()"
            >
              🔗
            </button>
          </nav>
        }

        <span class="md-view__spacer"></span>

        <app-v2-icon-btn
          iconName="code"
          [size]="26"
          [title]="(sourceMode() ? 'Show formatted view' : 'Show markdown source') | translate: locale.language"
          [active]="sourceMode()"
          (click)="toggleSourceMode()"
        />
        @if (writeable()) {
          <app-v2-icon-btn
            [iconName]="readonly() ? 'lock' : 'unlock'"
            [size]="26"
            [title]="(readonly() ? 'Read-only — click to edit' : 'Editing — click to lock as read-only') | translate: locale.language"
            (click)="toggleReadonly()"
          />
        }
        @if (inline()) {
          <app-v2-btn kind="ghost" size="sm" (click)="cancel()">
            {{ 'Cancel' | translate: locale.language }}
          </app-v2-btn>
        }
        <app-v2-btn kind="primary" size="sm" [disabled]="!canSave()" (click)="save()">
          {{ 'Save' | translate: locale.language }}
        </app-v2-btn>
      </header>

      <div class="md-view__body">
        @if (loading()) {
          <div class="md-view__state">{{ 'Loading…' | translate: locale.language }}</div>
        } @else if (loadError(); as err) {
          <!-- Translated like the folder-readme banner's equivalent: the value is
               either a server message (no key, so it falls through to itself) or one
               of the English literals below, which the custom bundle translates. -->
          <div class="md-view__state md-view__state--error">{{ err | translate: locale.language }}</div>
        } @else if (sourceMode()) {
          <code-editor
            #sourceEditor
            class="md-view__source"
            [autoFocus]="true"
            [language]="'markdown'"
            [(ngModel)]="sourceContent"
            (change)="onSourceChange()"
            [theme]="theme()"
            [readonly]="readonly() || !writeable()"
            [disabled]="readonly() || !writeable()"
            [lineWrapping]="true"
          />
        } @else {
          <!-- v2-prose is the shared markdown typography (styles/_prose.scss), the
               same partial the folder-readme banner's read mode uses, so switching
               between the two cannot reflow the text. -->
          <div class="md-view__editor v2-prose">
            <tiptap-editor class="md-view__editor-host" [editor]="editor"></tiptap-editor>
          </div>
        }
      </div>
    </div>
  `,
  styles: [
    `
      /* v2's design tokens are a navy ramp scoped under .v2-root — there's no
         neutral --si-bg; the canvas levels are --si-bg0…bg6. Use --si-bg0 to
         match the file-detail stage so the editor blends with the surrounding
         chrome instead of stamping a white sheet over it. */
      :host {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
        background: var(--si-bg0);
        color: var(--si-fg);
        min-height: 0;
      }
      .md-view {
        flex: 1 1 auto;
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      .md-view__head {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: var(--si-space-4);
        padding: var(--si-space-4) var(--si-space-6);
        background: var(--si-bg2, #f5f5f7);
        border-bottom: 1px solid var(--si-border, rgba(0, 0, 0, 0.08));
        flex-wrap: wrap;
      }
      .md-view__status {
        font-size: var(--si-text-6);
        color: var(--si-fg-muted, #666);
        font-variant-numeric: tabular-nums;
        min-width: 90px;
      }
      .md-view__toolbar {
        display: inline-flex;
        align-items: center;
        gap: var(--si-space-1);
        flex-wrap: wrap;
      }
      .md-tool {
        appearance: none;
        background: transparent;
        border: none;
        border-radius: 6px;
        color: var(--si-fg-muted, #666);
        cursor: pointer;
        font: inherit;
        height: 30px;
        min-width: 30px;
        padding: 0 var(--si-space-3);
        font-size: var(--si-text-8);
        line-height: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition:
          background 120ms ease,
          color 120ms ease;
      }
      .md-tool:hover {
        background: var(--si-bg3, rgba(0, 0, 0, 0.05));
        color: var(--si-fg, #111);
      }
      .md-tool--active {
        background: var(--si-bg4, rgba(0, 0, 0, 0.08));
        color: var(--si-fg, #111);
      }
      .md-tool--bold {
        font-weight: 700;
      }
      .md-tool--italic {
        font-style: italic;
      }
      .md-tool--strike {
        text-decoration: line-through;
      }
      .md-tool--mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: var(--si-text-6);
      }
      .md-tool__sep {
        width: 1px;
        height: 18px;
        background: var(--si-border, rgba(0, 0, 0, 0.12));
        margin: 0 var(--si-space-2);
      }
      .md-view__spacer {
        flex: 1 1 auto;
      }
      .md-view__body {
        flex: 1 1 auto;
        min-height: 0;
        position: relative;
        background: var(--si-bg0);
        overflow: auto;
      }
      .md-view__source {
        position: absolute;
        inset: 0;
        display: block;
      }
      .md-view__source ::ng-deep .cm-editor {
        height: 100%;
      }
      .md-view__source ::ng-deep .cm-focused {
        outline: none !important;
      }
      /* Inline mode (folder readme banner): the source editor drops out of
         absolute positioning — inset:0 against a bounded parent (rather than
         a stage filling the viewport) would collapse it to zero height. */
      .md-view--inline .md-view__source {
        position: static;
        inset: auto;
        min-height: 180px;
      }
      .md-view__editor {
        padding: var(--si-space-11) var(--si-space-13) 48px;
        max-width: 880px;
        margin: 0 auto;
      }
      /* Inline mode (folder readme banner): the text column must line up with the
         embedder's read block, or clicking Edit reflows the text being read. So
         the padding and the centring both go, and the measure comes from the
         embedder — the readme card sets --v2-inline-measure and its read block
         obeys the same value, which is what keeps the two identical. The fallback
         of none means an embedder that sets nothing still gets the old full-width
         behaviour. The 880px centred default above is for the file-detail stage,
         which has a viewport to centre in. */
      .md-view--inline .md-view__editor {
        padding: 0;
        max-width: var(--v2-inline-measure, none);
        margin: 0;
      }
      /* Everything about how markdown BODY text looks now comes from the shared
         .v2-prose partial on the wrapper above (styles/_prose.scss), which is
         global under .v2-root and so reaches ProseMirror's generated DOM without
         ::ng-deep. Only the two rules that are about the editor rather than the
         prose stay here. */
      .md-view__editor-host ::ng-deep .ProseMirror {
        outline: none;
        min-height: 200px;
      }
      .md-view__state {
        padding: var(--si-space-11);
        font-size: var(--si-text-8);
        color: var(--si-fg-muted, #666);
      }
      .md-view__state--error {
        color: var(--si-rose);
      }
    `
  ]
})
export class MarkdownViewComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient)
  private readonly filesService = inject(FilesService)
  private readonly filesUpload = inject(FilesUploadService)
  private readonly confirmDialog = inject(ConfirmDialogService)
  private readonly toast = inject(ToastService)
  private readonly layoutService = inject(LayoutService)
  private readonly closeGuard = inject(CloseGuardService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  readonly path = input.required<string>()
  readonly file = input.required<FileProps | null>()
  // The RESOLVED writeability verdict, not one half of it: the embedder owns the
  // whole contract (utils/file-writeable.ts) because only the embedder holds the
  // permission string, and only the embedder can know whether an exclusive lock on
  // the row is a stranger's or its own. Defaulted to false so an embedder that
  // forgets to bind gets a read-only editor rather than an editable-looking one it
  // has no right to — which is exactly what file-detail did until #372.
  readonly isWriteable = input<boolean>(false)
  // Inline mode: the component is embedded in a bounded container (the folder
  // readme banner) rather than filling the file-detail stage. Adds a Cancel
  // control and drops the height:100% assumption.
  readonly inline = input<boolean>(false)
  readonly done = output<void>()
  readonly saved = output<void>()
  // Pushed on every change of the modified state, for an embedding parent that has
  // to know about unsaved text at a moment when it can no longer ASK. The folder
  // readme banner is destroyed together with its browse screen when the user leaves
  // it, and Angular destroys this child first — so by the time the parent's
  // ngOnDestroy runs it can neither serialize the content nor resolve this
  // component through its view query. A pushed boolean survives both.
  readonly dirtyChange = output<boolean>()

  protected readonly editor = new Editor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: true } }),
      Image.configure({ allowBase64: true }),
      Markdown
    ],
    editable: false,
    content: '',
    contentType: 'markdown',
    onUpdate: () => this.onEditorChange(),
    onTransaction: () => {
      // Reactivity for toolbar active states — bumps a signal so the template
      // re-evaluates isActive() after every editor mutation.
      this.editorRev.update((v) => v + 1)
    }
  })

  protected readonly sourceContent = signal<string>('')
  protected readonly loading = signal(false)
  protected readonly loadError = signal<string | null>(null)
  protected readonly saving = signal(false)
  protected readonly isModified = signal(false)
  protected readonly readonly = signal(false)
  protected readonly writeable = signal(false)
  protected readonly sourceMode = signal(false)
  protected readonly lockOwner = signal<string | null>(null)
  protected readonly theme = signal<EditorTheme>(this.layoutService.switchTheme.getValue() === themeDark ? 'dark' : 'light')
  // Bumped on every TipTap transaction so the template's isActive() calls
  // re-run via Angular's change detection.
  protected readonly editorRev = signal(0)

  private stub: FileModel | null = null
  private savedContent = ''
  private suppressNextUpdate = false

  constructor() {
    effect(() => {
      const p = this.path()
      const f = this.file()
      if (!p || !f) return
      untracked(() => this.openFile(p, f))
    })
    effect(() => {
      // Keep editor's editable state in sync with read-only/writeable signals.
      const editable = this.writeable() && !this.readonly() && !this.loading()
      if (!this.editor.isDestroyed) {
        untracked(() => this.editor.setEditable(editable, false))
      }
    })
    // One place to mirror the modified state outwards, rather than an emit beside
    // each of the four writers to isModified.
    effect(() => {
      const dirty = this.isModified()
      untracked(() => this.dirtyChange.emit(dirty))
    })
    this.layoutService.switchTheme.subscribe((t: string) => this.theme.set(t === themeDark ? 'dark' : 'light'))
  }

  ngOnInit(): void {
    // CloseGuardService is a SINGLE-SLOT manual guard that only file-detail's
    // close() consults. An inline embedder (the folder readme banner) must not
    // touch it: registering would clobber whatever file-detail put there, and
    // nulling it on destroy would leave the slot empty rather than restored.
    // Design §5. The banner runs its own confirm via requestClose()/cancel().
    if (!this.inline()) this.closeGuard.setCloseGuard(() => this.canClose())
  }

  ngOnDestroy(): void {
    if (!this.inline()) this.closeGuard.setCloseGuard(null)
    if (!this.editor.isDestroyed) this.editor.destroy()
    if (this.stub?.lock) {
      const stub = this.stub
      this.filesService.unlock(stub).subscribe({
        error: (e: HttpErrorResponse) => console.warn('markdown-view: unlock on destroy failed', e)
      })
    }
  }

  @HostListener('document:keydown', ['$event'])
  protected onKeyDown(ev: KeyboardEvent): void {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault()
      ev.stopPropagation()
      this.save()
    }
  }

  // --- Toolbar helpers ---------------------------------------------------

  protected isActive(name: string, attrs?: Record<string, unknown>): boolean {
    // Touch the rev signal so this re-runs after every editor transaction.
    this.editorRev()
    if (this.editor.isDestroyed) return false
    return attrs ? this.editor.isActive(name, attrs) : this.editor.isActive(name)
  }

  protected canEditVisual(): boolean {
    return !this.sourceMode() && this.writeable() && !this.readonly()
  }

  protected toggleHeading(level: HeadingLevel): void {
    if (!this.canEditVisual()) return
    this.editor.chain().focus().toggleHeading({ level }).run()
  }

  protected toggleMark(name: InlineMark): void {
    if (!this.canEditVisual()) return
    this.editor.chain().focus().toggleMark(name).run()
  }

  protected toggleBulletList(): void {
    if (!this.canEditVisual()) return
    this.editor.chain().focus().toggleBulletList().run()
  }

  protected toggleOrderedList(): void {
    if (!this.canEditVisual()) return
    this.editor.chain().focus().toggleOrderedList().run()
  }

  protected toggleTaskList(): void {
    if (!this.canEditVisual()) return
    this.editor.chain().focus().toggleTaskList().run()
  }

  protected toggleBlockquote(): void {
    if (!this.canEditVisual()) return
    this.editor.chain().focus().toggleBlockquote().run()
  }

  protected toggleCodeBlock(): void {
    if (!this.canEditVisual()) return
    this.editor.chain().focus().toggleCodeBlock().run()
  }

  protected setLink(): void {
    if (!this.canEditVisual()) return
    const previousUrl = this.editor.getAttributes('link').href as string | undefined
    const url = window.prompt('URL', previousUrl ?? 'https://')
    if (url === null) return
    const chain = this.editor.chain().focus().extendMarkRange('link')
    if (!url.trim()) chain.unsetLink().run()
    else chain.setLink({ href: url.trim() }).run()
  }

  // --- Mode toggles ------------------------------------------------------

  protected toggleSourceMode(): void {
    if (this.sourceMode()) {
      // Source → visual: push edited markdown back into TipTap.
      this.setEditorMarkdown(this.sourceContent())
      this.sourceMode.set(false)
    } else {
      // Visual → source: serialize TipTap markdown into the source editor.
      this.sourceContent.set(this.getEditorMarkdown())
      this.sourceMode.set(true)
    }
  }

  protected onSourceChange(): void {
    if (!this.sourceMode()) return
    const content = this.sourceContent()
    if (content !== this.savedContent && !this.isModified()) {
      this.isModified.set(true)
    } else if (content === this.savedContent && this.isModified()) {
      this.isModified.set(false)
    }
  }

  // --- Lock + save -------------------------------------------------------

  protected async toggleReadonly(): Promise<void> {
    if (!this.writeable() || !this.stub) return
    if (this.readonly()) {
      try {
        const lock = await firstValueFrom(this.filesService.lock(this.stub))
        this.stub.lock = lock
        this.lockOwner.set(null)
        this.readonly.set(false)
      } catch (e) {
        this.handleLockError(e as HttpErrorResponse)
      }
    } else {
      try {
        await firstValueFrom(this.filesService.unlock(this.stub))
        this.stub.lock = null
      } catch (e) {
        console.warn('markdown-view: unlock failed', e)
      }
      this.readonly.set(true)
    }
  }

  protected canSave(): boolean {
    return !!this.stub && this.writeable() && !this.readonly() && this.isModified() && !this.saving()
  }

  protected save(): void {
    if (!this.canSave() || !this.stub) return
    this.saving.set(true)
    const content = this.currentMarkdown()
    this.filesUpload.uploadFileContent(this.stub, content, true).subscribe({
      next: () => {
        this.savedContent = content
        if (this.sourceMode()) this.sourceContent.set(content)
        this.saving.set(false)
        this.isModified.set(false)
        this.toast.success('v2_saved_one', { name: this.stub!.name })
        this.saved.emit()
      },
      error: (e: HttpErrorResponse) => {
        this.saving.set(false)
        this.toast.error(e?.error?.message ?? e?.statusText ?? 'Save failed')
      }
    })
  }

  protected async cancel(): Promise<void> {
    if (!(await this.canClose())) return
    this.done.emit()
  }

  // Awaitable save for an embedding parent that is being torn down and cannot
  // prompt (the folder readme banner on folder change). Returns 'clean' when
  // there was nothing to save, 'saved' on success, 'failed' otherwise. Never
  // throws — the caller is mid-teardown and must proceed either way.
  //
  // Both the content and the HTTP request are captured/issued synchronously
  // before the first await, so it stays correct even if this component is
  // destroyed while the request is in flight.
  //
  // Deliberately raises no toast and emits no `saved`: the embedding parent owns
  // the user-facing messaging for this path, and double-toasting would be noise.
  //
  // 'clean' means "nothing to save" — it must NOT also mean "have modified text
  // but cannot save it". The read-only toggle renders in inline mode gated only
  // on writeable() (see the template above), so a user can Edit, type, then click
  // the lock icon before navigating away: isModified() stays true while writeable()
  // flips false (or readonly() flips true). If that path returned 'clean', the
  // caller would attempt no save and, because the outcome isn't 'failed', raise no
  // v2_readme_autosave_failed toast either — the edited text would vanish with no
  // signal to the user at all. So: no modification at all → 'clean'; a
  // modification that cannot be attempted → 'failed', which fires the existing
  // toast. Do not collapse these back into one branch.
  async saveNowIfModified(): Promise<'clean' | 'saved' | 'failed'> {
    if (!this.stub || !this.isModified()) return 'clean'
    if (!this.writeable() || this.readonly()) return 'failed'
    const content = this.currentMarkdown()
    this.saving.set(true)
    try {
      await firstValueFrom(this.filesUpload.uploadFileContent(this.stub, content, true))
      this.savedContent = content
      this.isModified.set(false)
      return 'saved'
    } catch {
      return 'failed'
    } finally {
      this.saving.set(false)
    }
  }

  // --- Lifecycle internals ----------------------------------------------

  // Lets an embedding parent run the unsaved-changes confirm without
  // reimplementing it. Returns true when the parent may destroy this view.
  async requestClose(): Promise<boolean> {
    return this.canClose()
  }

  private async canClose(): Promise<boolean> {
    if (!this.isModified()) return true
    return this.confirmDialog.open({
      title: 'Unsaved changes',
      message: 'v2_discard_unsaved_changes',
      messageParams: { name: this.stub?.name ?? 'this file' },
      confirmLabel: 'Discard',
      kind: 'danger'
    })
  }

  private async openFile(path: string, file: FileProps): Promise<void> {
    this.resetState()
    this.loading.set(true)
    this.stub = buildFileModelStub(file, path)
    this.writeable.set(this.isWriteable())
    // The lock is still read here, but for a different question: not "may I write"
    // (isWriteable() already answered that, lock included) but "who is holding it",
    // so the header can name them. An embedder that legitimately owns the lock — the
    // folder readme banner — passes a row with it stripped, so this branch is
    // correctly skipped for it.
    if (file.lock?.isExclusive) {
      this.lockOwner.set(fileLockPropsToString(file.lock))
      this.readonly.set(true)
    } else {
      this.readonly.set(!this.isWriteable())
    }
    if (this.writeable() && !this.readonly()) {
      try {
        const lock = await firstValueFrom(this.filesService.lock(this.stub))
        this.stub.lock = lock
      } catch (e) {
        this.handleLockError(e as HttpErrorResponse)
      }
    }
    try {
      const text = await firstValueFrom(this.http.get(this.stub.dataUrl, { responseType: 'text' }))
      const content = text ?? ''
      this.savedContent = content
      this.sourceContent.set(content)
      this.setEditorMarkdown(content)
      this.loading.set(false)
    } catch (e) {
      const err = e as HttpErrorResponse
      this.loadError.set(err?.error?.message ?? err?.statusText ?? 'Failed to load file')
      this.loading.set(false)
    }
  }

  private handleLockError(e: HttpErrorResponse): void {
    if (e?.error?.owner) {
      const lock = e.error as FileLockProps
      this.lockOwner.set(fileLockPropsToString(lock))
      if (this.stub) this.stub.lock = lock
    } else {
      this.toast.error(e?.error?.message ?? e?.statusText ?? 'Could not lock file')
    }
    this.readonly.set(true)
    this.writeable.set(false)
  }

  private resetState(): void {
    this.loading.set(false)
    this.loadError.set(null)
    this.saving.set(false)
    this.isModified.set(false)
    this.readonly.set(false)
    this.writeable.set(false)
    this.sourceMode.set(false)
    this.lockOwner.set(null)
    this.sourceContent.set('')
    this.savedContent = ''
    this.stub = null
    if (!this.editor.isDestroyed) {
      this.suppressNextUpdate = true
      this.editor.commands.setContent('', { emitUpdate: false, contentType: 'markdown' })
    }
  }

  private setEditorMarkdown(content: string): void {
    if (this.editor.isDestroyed) return
    this.suppressNextUpdate = true
    this.editor.chain().setMeta('addToHistory', false).setContent(content, { emitUpdate: false, contentType: 'markdown' }).run()
  }

  private getEditorMarkdown(): string {
    if (this.editor.isDestroyed) return this.savedContent
    return this.editor.getMarkdown()
  }

  private currentMarkdown(): string {
    return this.sourceMode() ? this.sourceContent() : this.getEditorMarkdown()
  }

  private onEditorChange(): void {
    if (this.suppressNextUpdate) {
      this.suppressNextUpdate = false
      return
    }
    if (this.sourceMode()) return
    const content = this.getEditorMarkdown()
    if (content !== this.savedContent && !this.isModified()) this.isModified.set(true)
    else if (content === this.savedContent && this.isModified()) this.isModified.set(false)
  }
}
