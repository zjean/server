import { ChangeDetectionStrategy, Component, effect, ElementRef, HostListener, inject, signal, untracked, ViewChild } from '@angular/core'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { TAR_EXTENSION, TAR_GZ_EXTENSION, ZIP_EXTENSION } from '@sync-in-server/backend/src/applications/files/constants/compress'
import { ButtonComponent } from './button.component'
import { CheckboxComponent } from './checkbox.component'
import { CompressDialogService, CompressExtension } from './compress-dialog.service'

// Archive dialog for v2 bulk download. Mirrors the classic
// files-compression-dialog (name + tar/zip + compression toggle) but renders
// under .v2-root with the v2 design tokens, and is download-only (no
// "save in current directory" option — v2's archive action always downloads).
@Component({
  selector: 'app-v2-compress-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, CheckboxComponent, L10nTranslatePipe],
  template: `
    @if (pending(); as p) {
      <div class="compress-dialog__backdrop" (click)="cancel()"></div>
      <form class="compress-dialog" role="dialog" aria-modal="true" (click)="$event.stopPropagation()" (submit)="onSubmit($event)">
        <div class="compress-dialog__title">{{ p.title | translate: locale.language }}</div>
        @if (p.message) {
          <div class="compress-dialog__message">{{ p.message | translate: locale.language }}</div>
        }
        <div class="compress-dialog__row">
          <input
            #input
            type="text"
            class="compress-dialog__input"
            [value]="name()"
            (input)="onInput($event)"
            [placeholder]="p.placeholder ?? '' | translate: locale.language"
          />
          <select class="compress-dialog__select" [value]="extension()" (change)="onExtensionChange($event)">
            @for (ext of extensions; track ext) {
              <option [value]="ext">.{{ extensionLabel(ext) }}</option>
            }
          </select>
        </div>
        @if (errorMsg(); as err) {
          <div class="compress-dialog__error">{{ err | translate: locale.language }}</div>
        }
        <div class="compress-dialog__check" (click)="toggleCompression()">
          <app-v2-checkbox [state]="compression() ? 'checked' : 'unchecked'" ariaLabel="Enable compression" (toggled)="toggleCompression()" />
          <span>{{ 'Enable compression' | translate: locale.language }}</span>
          <small>{{ '(this may take longer)' | translate: locale.language }}</small>
        </div>
        <div class="compress-dialog__actions">
          <app-v2-btn kind="ghost" size="sm" (click)="cancel()">
            {{ p.cancelLabel ?? 'Cancel' | translate: locale.language }}
          </app-v2-btn>
          <button type="submit" hidden aria-hidden="true"></button>
          <app-v2-btn kind="primary" size="sm" [disabled]="!canSubmit()" (click)="submit()">
            {{ p.submitLabel | translate: locale.language }}
          </app-v2-btn>
        </div>
      </form>
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }
      .compress-dialog__backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.35);
        z-index: 72;
      }
      .compress-dialog {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 73;
        min-width: 340px;
        max-width: 440px;
        padding: 18px 20px 14px;
        background: var(--si-bg1);
        border: 1px solid var(--si-border);
        border-radius: 10px;
        box-shadow: var(--si-shadow3);
      }
      .compress-dialog__title {
        font-size: 15px;
        font-weight: 600;
        color: var(--si-fg);
        margin-bottom: 8px;
      }
      .compress-dialog__message {
        font-size: 13px;
        color: var(--si-fg-muted);
        line-height: 1.45;
        margin-bottom: 10px;
      }
      .compress-dialog__row {
        display: flex;
        gap: 8px;
      }
      .compress-dialog__input {
        flex: 1 1 auto;
        min-width: 0;
        box-sizing: border-box;
        font: inherit;
        font-size: 13px;
        padding: 8px 10px;
        background: var(--si-bg2);
        color: var(--si-fg);
        border: 1px solid var(--si-border);
        border-radius: 6px;
        outline: none;
        transition: border-color 120ms ease;
      }
      .compress-dialog__select {
        flex: 0 0 auto;
        width: 92px;
        box-sizing: border-box;
        font: inherit;
        font-size: 13px;
        padding: 8px 10px;
        background: var(--si-bg2);
        color: var(--si-fg);
        border: 1px solid var(--si-border);
        border-radius: 6px;
        outline: none;
        cursor: pointer;
        transition: border-color 120ms ease;
      }
      .compress-dialog__input:focus,
      .compress-dialog__select:focus {
        border-color: color-mix(in srgb, var(--si-accent) 60%, var(--si-border));
      }
      .compress-dialog__error {
        font-size: 11px;
        color: var(--si-rose);
        margin-top: 4px;
      }
      .compress-dialog__check {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 14px;
        font-size: 13px;
        color: var(--si-fg);
        cursor: pointer;
        user-select: none;
      }
      .compress-dialog__check small {
        color: var(--si-fg-muted);
        font-size: 11px;
      }
      .compress-dialog__actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        margin-top: 16px;
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
  protected readonly errorMsg = signal<string | null>(null)

  constructor() {
    effect(() => {
      const p = this.pending()
      untracked(() => {
        if (p) {
          this.name.set(p.initialValue ?? '')
          this.extension.set(TAR_EXTENSION)
          this.compression.set(true)
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
    this.service.resolve({ name, extension: this.extension(), compression: this.compression() })
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
