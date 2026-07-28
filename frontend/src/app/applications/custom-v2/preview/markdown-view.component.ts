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
          <div class="md-view__state md-view__state--error">{{ err }}</div>
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
          <div class="md-view__editor">
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
        gap: 8px;
        padding: 8px 12px;
        background: var(--si-bg2, #f5f5f7);
        border-bottom: 1px solid var(--si-border, rgba(0, 0, 0, 0.08));
        flex-wrap: wrap;
      }
      .md-view__status {
        font-size: 12px;
        color: var(--si-fg-muted, #666);
        font-variant-numeric: tabular-nums;
        min-width: 90px;
      }
      .md-view__toolbar {
        display: inline-flex;
        align-items: center;
        gap: 2px;
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
        padding: 0 6px;
        font-size: 13px;
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
        font-size: 12px;
      }
      .md-tool__sep {
        width: 1px;
        height: 18px;
        background: var(--si-border, rgba(0, 0, 0, 0.12));
        margin: 0 4px;
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
        padding: 24px 32px 48px;
        max-width: 880px;
        margin: 0 auto;
      }
      .md-view__editor-host ::ng-deep .ProseMirror {
        outline: none;
        min-height: 200px;
        font-size: 15px;
        line-height: 1.6;
        color: var(--si-fg);
      }
      .md-view__editor-host ::ng-deep .ProseMirror h1 {
        font-size: 1.9em;
        margin: 0.8em 0 0.4em;
        font-weight: 700;
      }
      .md-view__editor-host ::ng-deep .ProseMirror h2 {
        font-size: 1.5em;
        margin: 0.8em 0 0.4em;
        font-weight: 700;
      }
      .md-view__editor-host ::ng-deep .ProseMirror h3 {
        font-size: 1.25em;
        margin: 0.7em 0 0.3em;
        font-weight: 600;
      }
      .md-view__editor-host ::ng-deep .ProseMirror p {
        margin: 0.5em 0;
      }
      .md-view__editor-host ::ng-deep .ProseMirror ul,
      .md-view__editor-host ::ng-deep .ProseMirror ol {
        padding-left: 1.4em;
        margin: 0.5em 0;
      }
      .md-view__editor-host ::ng-deep .ProseMirror ul[data-type='taskList'] {
        list-style: none;
        padding-left: 0.2em;
      }
      .md-view__editor-host ::ng-deep .ProseMirror ul[data-type='taskList'] li {
        display: flex;
        gap: 0.4em;
        align-items: flex-start;
      }
      .md-view__editor-host ::ng-deep .ProseMirror ul[data-type='taskList'] li > label {
        flex-shrink: 0;
        margin-top: 0.2em;
      }
      .md-view__editor-host ::ng-deep .ProseMirror blockquote {
        margin: 0.5em 0;
        padding-left: 1em;
        border-left: 3px solid var(--si-border, rgba(0, 0, 0, 0.18));
        color: var(--si-fg-muted, #555);
      }
      .md-view__editor-host ::ng-deep .ProseMirror code {
        background: var(--si-bg3, rgba(0, 0, 0, 0.06));
        padding: 1px 4px;
        border-radius: 4px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.92em;
      }
      .md-view__editor-host ::ng-deep .ProseMirror pre {
        background: var(--si-bg3, rgba(0, 0, 0, 0.06));
        padding: 12px;
        border-radius: 6px;
        overflow: auto;
      }
      .md-view__editor-host ::ng-deep .ProseMirror pre code {
        background: none;
        padding: 0;
      }
      .md-view__editor-host ::ng-deep .ProseMirror a {
        color: var(--si-accent, #0a5fb8);
        text-decoration: underline;
      }
      .md-view__editor-host ::ng-deep .ProseMirror table {
        border-collapse: collapse;
        margin: 0.6em 0;
        width: 100%;
      }
      .md-view__editor-host ::ng-deep .ProseMirror th,
      .md-view__editor-host ::ng-deep .ProseMirror td {
        border: 1px solid var(--si-border, rgba(0, 0, 0, 0.18));
        padding: 6px 8px;
      }
      .md-view__editor-host ::ng-deep .ProseMirror img {
        max-width: 100%;
        height: auto;
      }
      .md-view__state {
        padding: 24px;
        font-size: 13px;
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
  readonly isWriteable = input<boolean>(true)
  // Inline mode: the component is embedded in a bounded container (the folder
  // readme banner) rather than filling the file-detail stage. Adds a Cancel
  // control and drops the height:100% assumption.
  readonly inline = input<boolean>(false)
  readonly done = output<void>()
  readonly saved = output<void>()

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
    this.layoutService.switchTheme.subscribe((t: string) => this.theme.set(t === themeDark ? 'dark' : 'light'))
  }

  ngOnInit(): void {
    this.closeGuard.setCloseGuard(() => this.canClose())
  }

  ngOnDestroy(): void {
    this.closeGuard.setCloseGuard(null)
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
  async saveNowIfModified(): Promise<'clean' | 'saved' | 'failed'> {
    if (!this.stub || !this.isModified() || !this.writeable() || this.readonly()) return 'clean'
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
    this.writeable.set(this.isWriteable() && !file.lock?.isExclusive)
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
