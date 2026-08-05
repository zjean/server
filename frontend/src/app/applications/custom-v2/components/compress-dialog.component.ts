import { ChangeDetectionStrategy, Component, effect, ElementRef, HostListener, inject, signal, untracked, ViewChild } from '@angular/core'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { TAR_EXTENSION, TAR_GZ_EXTENSION, ZIP_EXTENSION } from '@sync-in-server/backend/src/applications/files/constants/compress'
import { ButtonComponent } from './button.component'
import { CheckboxComponent } from './checkbox.component'
import { CompressDialogService, CompressExtension } from './compress-dialog.service'

// Archive dialog for v2 bulk archiving. Full parity with the classic
// files-compression-dialog (name + tar/zip + compression toggle + save-in-place
// vs download), rendered under .v2-root with the v2 design tokens. The title
// flips with the save-in-place choice exactly like classic.
@Component({
  selector: 'app-v2-compress-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, CheckboxComponent, L10nTranslatePipe],
  template: `
    @if (pending(); as p) {
      <div class="v2-dialog-backdrop" (click)="cancel()"></div>
      <form class="v2-dialog compress-dialog" role="dialog" aria-modal="true" (click)="$event.stopPropagation()" (submit)="onSubmit($event)">
        <div class="v2-dialog__head">
          <div class="compress-dialog__head-text">
            <div class="v2-dialog__title">
              {{ (inDirectory() ? 'Compress and Save' : 'Compress and Download') | translate: locale.language }}
            </div>
          </div>
          <div class="v2-dialog__spacer"></div>
          <div class="compress-dialog__count">{{ p.fileCount }} {{ (p.fileCount > 1 ? 'items' : 'item') | translate: locale.language }}</div>
        </div>
        <div class="v2-dialog__body">
          <div class="compress-dialog__row">
            <input
              #input
              type="text"
              class="compress-dialog__input"
              [value]="name()"
              (input)="onInput($event)"
              [placeholder]="'Archive name' | translate: locale.language"
            />
            <select class="compress-dialog__select" [value]="extension()" (change)="onExtensionChange($event)">
              @for (ext of extensions; track ext) {
                <option [value]="ext">.{{ extensionLabel(ext) }}</option>
              }
            </select>
          </div>
          <div class="compress-dialog__check" (click)="toggleCompression()">
            <app-v2-checkbox [state]="compression() ? 'checked' : 'unchecked'" ariaLabel="Enable compression" (toggled)="toggleCompression()" />
            <span>{{ 'Enable compression' | translate: locale.language }}</span>
            <small>{{ '(this may take longer)' | translate: locale.language }}</small>
          </div>
          @if (p.allowSaveInPlace !== false) {
            <div class="compress-dialog__check" (click)="toggleInDirectory()">
              <app-v2-checkbox
                [state]="inDirectory() ? 'checked' : 'unchecked'"
                ariaLabel="Save in the current directory"
                (toggled)="toggleInDirectory()"
              />
              <span>{{ 'Save in the current directory' | translate: locale.language }}</span>
            </div>
          }
        </div>
        @if (errorMsg(); as err) {
          <div class="v2-dialog__error">{{ err | translate: locale.language }}</div>
        }
        <div class="v2-dialog__footer">
          <div class="v2-dialog__spacer"></div>
          <app-v2-btn kind="ghost" size="sm" (click)="cancel()">
            {{ 'Cancel' | translate: locale.language }}
          </app-v2-btn>
          <button type="submit" hidden aria-hidden="true"></button>
          <app-v2-btn kind="primary" size="sm" [disabled]="!canSubmit()" (click)="submit()">
            {{ 'Confirm' | translate: locale.language }}
          </app-v2-btn>
        </div>
      </form>
    }
  `,
  styles: [
    `
      /* Frame, scrim, head, body, error and footer come from styles/_dialog.scss. */
      :host {
        display: contents;
      }
      .compress-dialog__count {
        font-size: var(--si-text-6);
        color: var(--si-fg-muted);
        white-space: nowrap;
      }
      .compress-dialog__row {
        display: flex;
        gap: var(--si-space-4);
      }
      .compress-dialog__input {
        flex: 1 1 auto;
        min-width: 0;
        box-sizing: border-box;
        font: inherit;
        font-size: var(--si-text-8);
        padding: var(--si-space-4) var(--si-space-5);
        background: var(--si-bg3);
        color: var(--si-fg);
        border: 1px solid var(--si-border);
        border-radius: var(--si-r1);
        outline: none;
        transition: border-color 120ms ease;
      }
      .compress-dialog__select {
        flex: 0 0 auto;
        width: 92px;
        box-sizing: border-box;
        font: inherit;
        font-size: var(--si-text-8);
        padding: var(--si-space-4) var(--si-space-5);
        background: var(--si-bg3);
        color: var(--si-fg);
        border: 1px solid var(--si-border);
        border-radius: var(--si-r1);
        outline: none;
        cursor: pointer;
        transition: border-color 120ms ease;
      }
      .compress-dialog__input:focus,
      .compress-dialog__select:focus {
        border-color: color-mix(in srgb, var(--si-accent) 60%, var(--si-border));
      }
      .compress-dialog__check {
        display: flex;
        align-items: center;
        gap: var(--si-space-4);
        margin-top: var(--si-space-6);
        font-size: var(--si-text-8);
        color: var(--si-fg);
        cursor: pointer;
        user-select: none;
      }
      .compress-dialog__check small {
        color: var(--si-fg-muted);
        font-size: var(--si-text-4);
      }
    `
  ]
})
export class CompressDialogComponent {
  private readonly service = inject(CompressDialogService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  @ViewChild('input') private input?: ElementRef<HTMLInputElement>

  protected readonly pending = this.service.pending
  protected readonly extensions: CompressExtension[] = [TAR_EXTENSION, ZIP_EXTENSION]
  protected readonly name = signal('')
  protected readonly extension = signal<CompressExtension>(TAR_EXTENSION)
  protected readonly compression = signal(true)
  protected readonly inDirectory = signal(false)
  protected readonly errorMsg = signal<string | null>(null)

  constructor() {
    effect(() => {
      const p = this.pending()
      untracked(() => {
        if (p) {
          this.name.set(p.initialValue ?? '')
          this.extension.set(TAR_EXTENSION)
          this.compression.set(true)
          this.inDirectory.set(false)
          this.errorMsg.set(null)
          queueMicrotask(() => this.focusInput())
        } else {
          this.name.set('')
          this.errorMsg.set(null)
        }
      })
    })
  }

  // Matches classic extensionLabel + the backend's outputExtension rule
  // (files.service.ts): tar + compression renders as .tgz; everything else
  // keeps its own extension (zip stays zip whether or not compression is on).
  protected extensionLabel(ext: CompressExtension): string {
    return ext === TAR_EXTENSION && this.compression() ? TAR_GZ_EXTENSION : ext
  }

  protected canSubmit(): boolean {
    return this.pending() !== null && this.name().trim().length > 0 && this.errorMsg() === null
  }

  protected onInput(ev: Event): void {
    const next = (ev.target as HTMLInputElement).value
    this.name.set(next)
    const validate = this.pending()?.validate
    this.errorMsg.set(validate ? validate(next) : null)
  }

  protected onExtensionChange(ev: Event): void {
    this.extension.set((ev.target as HTMLSelectElement).value as CompressExtension)
  }

  protected toggleCompression(): void {
    this.compression.update((v) => !v)
  }

  protected toggleInDirectory(): void {
    this.inDirectory.update((v) => !v)
  }

  protected onSubmit(ev: Event): void {
    ev.preventDefault()
    this.submit()
  }

  protected submit(): void {
    if (!this.canSubmit()) return
    const name = this.name().trim()
    const validate = this.pending()?.validate
    const err = validate ? validate(name) : null
    if (err) {
      this.errorMsg.set(err)
      return
    }
    this.service.resolve({
      name,
      extension: this.extension(),
      compression: this.compression(),
      compressInDirectory: this.inDirectory()
    })
  }

  protected cancel(): void {
    this.service.resolve(null)
  }

  @HostListener('window:keydown.escape')
  onEscape(): void {
    if (this.pending()) this.cancel()
  }

  private focusInput(): void {
    const el = this.input?.nativeElement
    if (!el) return
    el.focus()
    el.select()
  }
}
