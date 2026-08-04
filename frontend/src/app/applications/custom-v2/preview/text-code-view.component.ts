import { CodeEditor } from '@acrodata/code-editor'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild
} from '@angular/core'
import { FormsModule } from '@angular/forms'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { closeSearchPanel, openSearchPanel } from '@codemirror/search'
import type { FileLockProps, FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
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
import { VersionsService } from '../services/versions.service'
import { buildFileModelStub } from '../utils/file-model-stub'
import { CloseGuardService } from './close-guard.service'
import { EditorStatus } from './editor-save-state'

type EditorTheme = 'light' | 'dark'

// Text/code editor inside the unified preview. Port of the v1 text-editor-
// dialog component, minus the modal trappings (backdrop, fixed positioning,
// own close button) — those are owned by the preview shell. Owns the lock
// lifecycle for the duration of the view (acquire on open if writeable,
// release on destroy), the dirty-tracking, save, theme, and CodeMirror
// search/wrap toggles.
//
// Registers a close-guard with CloseGuardService so the file-detail
// close() / Esc paths surface the unsaved-changes confirm dialog before
// navigating away. Browser-back is uncancellable; ngOnDestroy still
// releases the lock there but the in-memory edits are lost.
@Component({
  selector: 'app-v2-preview-text-code-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CodeEditor, FormsModule, ButtonComponent, IconButtonComponent, L10nTranslatePipe],
  template: `
    <div class="text-view">
      <header class="text-view__head">
        <!-- The state is a badge in the embedder's identity band (D4), not a
             sentence here. This editor is only ever embedded by file-detail, which
             has the band, so the sentence goes entirely. -->
        <span class="text-view__spacer"></span>
        @if (versionsAvailable()) {
          <span class="text-view__hint">{{ 'v2_saves_a_version' | translate: locale.language : { key: saveShortcutKey } }}</span>
        }
        <app-v2-icon-btn
          iconName="search"
          [size]="26"
          [title]="'Search (Ctrl/Cmd+F)' | translate: locale.language"
          [active]="searchOpen()"
          (click)="toggleSearch()"
        />
        <app-v2-icon-btn
          iconName="list"
          [size]="26"
          [title]="'Line wrap' | translate: locale.language"
          [active]="lineWrap()"
          (click)="toggleLineWrap()"
        />
        @if (writeable()) {
          <app-v2-icon-btn
            [iconName]="readonly() ? 'lock' : 'unlock'"
            [size]="26"
            [title]="(readonly() ? 'Read-only — click to edit' : 'Editing — click to lock as read-only') | translate: locale.language"
            (click)="toggleReadonly()"
          />
        }
        <!-- Secondary: the identity band's Share is this view's one primary. -->
        <app-v2-btn kind="secondary" size="sm" [disabled]="!writeable() || readonly() || !isModified() || saving()" (click)="save()">
          {{ 'Save' | translate: locale.language }}
        </app-v2-btn>
      </header>
      <div class="text-view__body">
        @if (loading()) {
          <div class="text-view__state">{{ 'Loading…' | translate: locale.language }}</div>
        } @else if (loadError(); as err) {
          <div class="text-view__state text-view__state--error">{{ err }}</div>
        } @else {
          <code-editor
            #editor
            class="text-view__editor"
            [autoFocus]="true"
            [languages]="languagesList"
            [language]="language()"
            [(ngModel)]="content"
            (change)="onContentChange()"
            [theme]="theme()"
            [readonly]="readonly() || !writeable()"
            [disabled]="readonly() || !writeable()"
            [lineWrapping]="lineWrap()"
          />
        }
      </div>
    </div>
  `,
  styles: [
    `
      /* v2's tokens live at .v2-root and are a navy ramp (--si-bg0…bg6); there
         is no neutral --si-bg. Using --si-bg0 matches .detail__stage so the
         viewer blends with surrounding chrome instead of stamping a sheet. */
      :host {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
        background: var(--si-bg0);
        color: var(--si-fg);
        min-height: 0;
      }
      .text-view {
        flex: 1 1 auto;
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      .text-view__head {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: var(--si-space-4);
        padding: var(--si-space-4) var(--si-space-6);
        background: var(--si-bg2);
        border-bottom: 1px solid var(--si-border);
      }
      .text-view__status {
        font-size: var(--si-text-6);
        color: var(--si-fg-muted);
        font-variant-numeric: tabular-nums;
      }
      /* A keystroke is machine vocabulary, so mono, and quiet: a reminder, not a
         control. */
      .text-view__hint {
        font-family: var(--si-mono);
        font-size: var(--si-text-4);
        color: var(--si-fg-ghost);
        white-space: nowrap;
        margin-right: var(--si-space-4);
      }
      .text-view__spacer {
        flex: 1 1 auto;
      }
      .text-view__body {
        flex: 1 1 auto;
        min-height: 0;
        position: relative;
        background: var(--si-bg0);
      }
      .text-view__editor {
        position: absolute;
        inset: 0;
        display: block;
      }
      .text-view__editor ::ng-deep .cm-editor {
        height: 100%;
      }
      .text-view__editor ::ng-deep .cm-focused {
        outline: none !important;
      }
      .text-view__state {
        padding: var(--si-space-11);
        font-size: var(--si-text-8);
        color: var(--si-fg-muted);
      }
      /* -ink, not the base tone: --si-rose is a FILL. As type on this surface it
         measures 3.6:1, below the 4.5 a 13px string needs. */
      .text-view__state--error {
        color: var(--si-rose-ink);
      }
    `
  ]
})
export class TextCodeViewComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient)
  private readonly filesService = inject(FilesService)
  private readonly filesUpload = inject(FilesUploadService)
  private readonly confirmDialog = inject(ConfirmDialogService)
  private readonly toast = inject(ToastService)
  private readonly layoutService = inject(LayoutService)
  private readonly closeGuard = inject(CloseGuardService)
  private readonly versions = inject(VersionsService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  protected readonly editor = viewChild<CodeEditor>('editor')

  // Inputs from PreviewComponent — change reactively when the user navigates
  // siblings inside the overlay.
  readonly path = input.required<string>()
  readonly file = input.required<FileProps | null>()
  // The RESOLVED writeability verdict, not one half of it: the embedder owns the
  // whole contract (utils/file-writeable.ts) because only the embedder holds the
  // permission string, and only the embedder can know whether an exclusive lock on
  // the row is a stranger's or its own. Defaulted to false so an embedder that
  // forgets to bind gets a read-only editor rather than an editable-looking one it
  // has no right to — which is exactly what file-detail did until #372. The
  // backend's LOCK request is still the enforcement; this is about not presenting
  // an affordance that the enforcement will refuse.
  readonly isWriteable = input<boolean>(false)
  // The save state, for the embedder's identity badge. Same contract as
  // markdown-view's, and for the same reason — see editor-save-state.ts.
  readonly statusChange = output<EditorStatus>()

  protected readonly content = signal<string>('')
  protected readonly loading = signal(false)
  protected readonly loadError = signal<string | null>(null)
  protected readonly saving = signal(false)
  protected readonly isModified = signal(false)
  protected readonly readonly = signal(false)
  protected readonly writeable = signal(false)
  protected readonly lineWrap = signal(false)
  protected readonly searchOpen = signal(false)
  protected readonly lockOwner = signal<string | null>(null)
  protected readonly theme = signal<EditorTheme>(this.layoutService.switchTheme.getValue() === themeDark ? 'dark' : 'light')
  protected readonly languagesList: LanguageDescription[] = languages
  // Whether a save here mints a version, which is what makes the ⌘S hint true.
  // Settled by the same session-wide probe the inspector's Versions tab uses.
  protected readonly versionsAvailable = computed(() => this.versions.availability() === 'available')

  protected readonly saveShortcutKey: string = (() => {
    if (typeof navigator === 'undefined') return 'Ctrl S'
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '') || /Mac/.test(navigator.userAgent || '')
    return isMac ? '⌘S' : 'Ctrl S'
  })()
  protected readonly language = computed<string | undefined>(() => {
    const f = this.file()
    if (!f) return undefined
    const match = LanguageDescription.matchFilename(languages, f.name)
    return match?.name
  })

  // FileModel stub — built per-input so save / lock / unlock all see the
  // same lock state. Never null while the editor is mounted with a valid
  // file; recreated on every input change in the loadFile effect.
  private stub: FileModel | null = null
  // Suppress the dirty flag set by CodeMirror's first contentChange after
  // we assign the loaded text.
  private contentReady = false

  constructor() {
    // Re-load whenever path or file changes (in-overlay sibling nav).
    effect(() => {
      const p = this.path()
      const f = this.file()
      if (!p || !f) return
      // Async work outside the reactive read so signal writes don't re-fire.
      untracked(() => this.openFile(p, f))
    })
    // One place to mirror the state the embedder draws as a badge. Ordered exactly
    // like the sentence it replaces, so the two cannot disagree.
    effect(() => {
      const status: EditorStatus = this.loading()
        ? { state: 'loading' }
        : this.saving()
          ? { state: 'saving' }
          : this.isModified()
            ? { state: 'modified' }
            : this.lockOwner()
              ? { state: 'readonly', lockOwner: this.lockOwner() }
              : !this.writeable()
                ? { state: 'readonly' }
                : { state: 'saved' }
      untracked(() => this.statusChange.emit(status))
    })
    // Theme tracking — global setting can flip while editor is open.
    this.layoutService.switchTheme.subscribe((t: string) => this.theme.set(t === themeDark ? 'dark' : 'light'))
  }

  ngOnInit(): void {
    this.closeGuard.setCloseGuard(() => this.canClose())
  }

  ngOnDestroy(): void {
    this.closeGuard.setCloseGuard(null)
    // Release lock if we hold one. Best-effort — server-side ignores if we
    // never had the lock, and we don't want to block destroy on the request.
    if (this.stub?.lock) {
      const stub = this.stub
      this.filesService.unlock(stub).subscribe({
        error: (e: HttpErrorResponse) => console.warn('text-view: unlock on destroy failed', e)
      })
    }
  }

  // Keyboard shortcuts. Mirror the dialog's: Cmd/Ctrl+S saves, Cmd/Ctrl+F
  // toggles search. Esc inside the editor first closes any open search
  // panel before bubbling to the shell's overlay-close handler.
  @HostListener('document:keydown', ['$event'])
  protected onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && this.searchOpen()) {
      ev.preventDefault()
      ev.stopPropagation()
      this.toggleSearch()
      return
    }
    if (ev.ctrlKey || ev.metaKey) {
      const k = ev.key.toLowerCase()
      if (k === 's') {
        ev.preventDefault()
        ev.stopPropagation()
        this.save()
        return
      }
      if (k === 'f') {
        ev.preventDefault()
        ev.stopPropagation()
        this.toggleSearch()
        return
      }
    }
  }

  protected onContentChange(): void {
    if (!this.contentReady) {
      this.contentReady = true
      return
    }
    if (!this.isModified()) this.isModified.set(true)
  }

  protected toggleLineWrap(): void {
    this.lineWrap.update((v) => !v)
  }

  protected toggleSearch(): void {
    const view = this.editor()?.view
    if (!view) return
    const next = !this.searchOpen()
    this.searchOpen.set(next)
    if (next) openSearchPanel(view)
    else closeSearchPanel(view)
  }

  protected async toggleReadonly(): Promise<void> {
    if (!this.writeable() || !this.stub) return
    if (this.readonly()) {
      // switch to editing → re-acquire lock
      try {
        const lock = await firstValueFrom(this.filesService.lock(this.stub))
        this.stub.lock = lock
        this.lockOwner.set(null)
        this.readonly.set(false)
      } catch (e) {
        this.handleLockError(e as HttpErrorResponse)
      }
    } else {
      // switch to read-only → release lock
      try {
        await firstValueFrom(this.filesService.unlock(this.stub))
        this.stub.lock = null
      } catch (e) {
        // unlock failures are non-fatal
        console.warn('text-view: unlock failed', e)
      }
      this.readonly.set(true)
    }
  }

  protected save(): void {
    if (!this.stub || this.saving() || this.readonly() || !this.writeable() || !this.isModified()) return
    this.saving.set(true)
    this.filesUpload.uploadFileContent(this.stub, this.content(), true).subscribe({
      next: () => {
        this.saving.set(false)
        this.isModified.set(false)
        this.toast.success('v2_saved_one', { name: this.stub!.name })
      },
      error: (e: HttpErrorResponse) => {
        this.saving.set(false)
        this.toast.error(e?.error?.message ?? e?.statusText ?? 'Save failed')
      }
    })
  }

  // Close-guard hook called by CloseGuardService.canClose(). Returns true
  // to allow close, false to cancel.
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
    // so the header can name them.
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
      this.contentReady = false
      this.content.set(text ?? '')
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
    this.content.set('')
    this.loading.set(false)
    this.loadError.set(null)
    this.saving.set(false)
    this.isModified.set(false)
    this.readonly.set(false)
    this.writeable.set(false)
    this.lineWrap.set(false)
    this.searchOpen.set(false)
    this.lockOwner.set(null)
    this.contentReady = false
    this.stub = null
  }
}
