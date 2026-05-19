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
import { buildFileModelStub } from '../utils/file-model-stub'
import { CloseGuardService } from './close-guard.service'

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
        <span class="text-view__status">
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
        <span class="text-view__spacer"></span>
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
        <app-v2-btn kind="primary" size="sm" [disabled]="!writeable() || readonly() || !isModified() || saving()" (click)="save()">
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
      :host {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
        background: var(--si-bg, #fff);
        color: var(--si-fg, #111);
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
        gap: 8px;
        padding: 8px 12px;
        background: var(--si-bg2, #f5f5f7);
        border-bottom: 1px solid var(--si-border, rgba(0, 0, 0, 0.08));
      }
      .text-view__status {
        font-size: 12px;
        color: var(--si-fg-muted, #666);
        font-variant-numeric: tabular-nums;
      }
      .text-view__spacer {
        flex: 1 1 auto;
      }
      .text-view__body {
        flex: 1 1 auto;
        min-height: 0;
        position: relative;
        background: var(--si-bg, #fff);
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
        padding: 24px;
        font-size: 13px;
        color: var(--si-fg-muted, #666);
      }
      .text-view__state--error {
        color: var(--si-danger, #c0392b);
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
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  protected readonly editor = viewChild<CodeEditor>('editor')

  // Inputs from PreviewComponent — change reactively when the user navigates
  // siblings inside the overlay.
  readonly path = input.required<string>()
  readonly file = input.required<FileProps | null>()
  // Whether the current user has MODIFY on this file. Defaulted optimistically
  // to true; the backend's LOCK request enforces the actual permission.
  readonly isWriteable = input<boolean>(true)

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
    this.filesUpload.uploadOneFile(this.stub, this.content(), true).subscribe({
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
