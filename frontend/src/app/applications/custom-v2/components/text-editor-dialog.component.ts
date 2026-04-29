import { CodeEditor } from '@acrodata/code-editor'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, effect, HostListener, inject, signal, untracked, viewChild } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { closeSearchPanel, openSearchPanel } from '@codemirror/search'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import type { FileLockProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { firstValueFrom } from 'rxjs'
import { themeDark } from '../../../layout/layout.interfaces'
import { LayoutService } from '../../../layout/layout.service'
import { FileModel } from '../../files/models/file.model'
import { FilesService } from '../../files/services/files.service'
import { FilesUploadService } from '../../files/services/files-upload.service'
import { fileLockPropsToString } from '../../files/components/utils/file-lock.utils'
import { buildFileModelStub } from '../utils/file-model-stub'
import { ButtonComponent } from './button.component'
import { ConfirmDialogService } from './confirm-dialog.service'
import { IconButtonComponent } from './icon-button.component'
import { TextEditorDialogService, TextEditorDialogInput } from './text-editor-dialog.service'
import { ToastService } from './toast.service'

type EditorTheme = 'light' | 'dark'

@Component({
  selector: 'app-v2-text-editor-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CodeEditor, FormsModule, ButtonComponent, IconButtonComponent, L10nTranslatePipe],
  template: `
    @if (pending(); as p) {
      <div class="ted__backdrop" (click)="onBackdropClick()"></div>
      <div class="ted" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
        <header class="ted__head">
          <span class="ted__name" [attr.title]="p.file.name">{{ p.file.name }}</span>
          <span class="ted__status">
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
          <span class="ted__spacer"></span>
          <app-v2-icon-btn
            iconName="search"
            [size]="26"
            title="Search (Ctrl/Cmd+F)"
            [active]="searchOpen()"
            (click)="toggleSearch()"
          />
          <app-v2-icon-btn
            iconName="list"
            [size]="26"
            title="Line wrap"
            [active]="lineWrap()"
            (click)="toggleLineWrap()"
          />
          @if (writeable()) {
            <app-v2-icon-btn
              [iconName]="readonly() ? 'lock' : 'unlock'"
              [size]="26"
              [title]="readonly() ? 'Read-only — click to edit' : 'Editing — click to lock as read-only'"
              (click)="toggleReadonly()"
            />
          }
          <app-v2-btn
            kind="primary"
            size="sm"
            [disabled]="!writeable() || readonly() || !isModified() || saving()"
            (click)="save()"
          >
            {{ 'Save' | translate: locale.language }}
          </app-v2-btn>
          <app-v2-icon-btn iconName="x" [size]="26" title="Close (Esc)" (click)="onCloseClick()" />
        </header>
        <div class="ted__body">
          @if (loading()) {
            <div class="ted__state">{{ 'Loading…' | translate: locale.language }}</div>
          } @else if (loadError(); as err) {
            <div class="ted__state ted__state--error">{{ err }}</div>
          } @else {
            <code-editor
              #editor
              class="ted__editor"
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
    }
  `,
  styles: [
    `
      :host {
        position: fixed;
        inset: 0;
        z-index: 1000;
        pointer-events: none;
      }
      :host:has(.ted) {
        pointer-events: auto;
      }
      .ted__backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
      }
      .ted {
        position: fixed;
        inset: 24px;
        display: flex;
        flex-direction: column;
        background: var(--si-bg, #fff);
        color: var(--si-fg, #111);
        border-radius: 12px;
        box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
        overflow: hidden;
      }
      .ted__head {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        background: var(--si-bg2, #f5f5f7);
        border-bottom: 1px solid var(--si-border, rgba(0, 0, 0, 0.08));
      }
      .ted__name {
        font-weight: 600;
        font-size: 13px;
        max-width: 30ch;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ted__status {
        font-size: 12px;
        color: var(--si-fg-muted, #666);
        font-variant-numeric: tabular-nums;
      }
      .ted__spacer {
        flex: 1 1 auto;
      }
      .ted__body {
        flex: 1 1 auto;
        min-height: 0;
        position: relative;
        background: var(--si-bg, #fff);
      }
      .ted__editor {
        position: absolute;
        inset: 0;
        display: block;
      }
      .ted__editor ::ng-deep .cm-editor {
        height: 100%;
      }
      .ted__editor ::ng-deep .cm-focused {
        outline: none !important;
      }
      .ted__state {
        padding: 24px;
        font-size: 13px;
        color: var(--si-fg-muted, #666);
      }
      .ted__state--error {
        color: var(--si-danger, #c0392b);
      }
    `
  ]
})
export class TextEditorDialogComponent {
  private readonly dialog = inject(TextEditorDialogService)
  private readonly http = inject(HttpClient)
  private readonly filesService = inject(FilesService)
  private readonly filesUpload = inject(FilesUploadService)
  private readonly confirmDialog = inject(ConfirmDialogService)
  private readonly toast = inject(ToastService)
  private readonly layoutService = inject(LayoutService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  protected readonly editor = viewChild<CodeEditor>('editor')

  protected readonly pending = this.dialog.pending
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
    const p = this.pending()
    if (!p) return undefined
    const match = LanguageDescription.matchFilename(languages, p.file.name)
    return match?.name
  })

  // Keep a ref to the FileModel stub built per-open so save/lock/unlock all see the same lock state.
  private stub: FileModel | null = null
  // Suppress the dirty flag set by CodeMirror's first contentChange after we assign the loaded text.
  private contentReady = false

  constructor() {
    // React to dialog open: build stub, lock if writeable, load content.
    effect(() => {
      const p = this.pending()
      if (!p) {
        // Dialog closed externally — reset state but don't fire async work here.
        this.resetState()
        return
      }
      // Do the async setup outside the reactive context so signal writes don't re-trigger this effect.
      untracked(() => this.openFile(p))
    })
    // Theme tracking for CodeMirror — global setting can flip while the dialog is open.
    this.layoutService.switchTheme.subscribe((t: string) => this.theme.set(t === themeDark ? 'dark' : 'light'))
  }

  @HostListener('document:keydown', ['$event'])
  protected onKeyDown(ev: KeyboardEvent): void {
    if (!this.pending()) return
    if (ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      if (this.searchOpen()) {
        this.toggleSearch()
      } else {
        this.onCloseClick()
      }
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
    // CodeMirror fires (change) on initial value bind too — ignore that one.
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
    if (next) {
      openSearchPanel(view)
    } else {
      closeSearchPanel(view)
    }
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
        console.warn('text-editor: unlock failed', e)
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
        this.toast.success(`Saved "${this.stub!.name}"`)
      },
      error: (e: HttpErrorResponse) => {
        this.saving.set(false)
        this.toast.error(e?.error?.message ?? e?.statusText ?? 'Save failed')
      }
    })
  }

  protected async onBackdropClick(): Promise<void> {
    await this.attemptClose()
  }

  protected async onCloseClick(): Promise<void> {
    await this.attemptClose()
  }

  private async attemptClose(): Promise<void> {
    if (this.isModified()) {
      const ok = await this.confirmDialog.open({
        title: 'Unsaved changes',
        message: `Discard unsaved changes to "${this.stub?.name ?? 'this file'}"?`,
        confirmLabel: 'Discard',
        kind: 'danger'
      })
      if (!ok) return
    }
    if (this.stub && this.stub.lock) {
      try {
        await firstValueFrom(this.filesService.unlock(this.stub))
      } catch (e) {
        console.warn('text-editor: unlock on close failed', e)
      }
    }
    this.dialog.close()
  }

  private async openFile(p: TextEditorDialogInput): Promise<void> {
    this.resetState()
    this.loading.set(true)
    this.stub = buildFileModelStub(p.file, p.fullPath)
    this.writeable.set(p.isWriteable && !p.file.lock?.isExclusive)
    // If the file is exclusively locked by someone else, force read-only and surface the owner.
    if (p.file.lock?.isExclusive) {
      this.lockOwner.set(fileLockPropsToString(p.file.lock))
      this.readonly.set(true)
    } else {
      this.readonly.set(!p.isWriteable)
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
