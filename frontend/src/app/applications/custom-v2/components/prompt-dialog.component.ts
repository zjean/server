import { ChangeDetectionStrategy, Component, effect, ElementRef, HostListener, inject, signal, untracked, ViewChild } from '@angular/core'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { ButtonComponent } from './button.component'
import { PromptDialogService } from './prompt-dialog.service'

@Component({
  selector: 'app-v2-prompt-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, L10nTranslatePipe],
  template: `
    @if (pending(); as p) {
      <div class="prompt-dialog__backdrop" (click)="cancel()"></div>
      <form class="prompt-dialog" role="dialog" aria-modal="true" (click)="$event.stopPropagation()" (submit)="onSubmit($event)">
        <div class="prompt-dialog__title">{{ p.title | translate: locale.language }}</div>
        @if (p.message) {
          <div class="prompt-dialog__message">{{ p.message | translate: locale.language }}</div>
        }
        <input
          #input
          type="text"
          class="prompt-dialog__input"
          [value]="value()"
          (input)="onInput($event)"
          [placeholder]="p.placeholder ?? '' | translate: locale.language"
        />
        @if (errorMsg(); as err) {
          <div class="prompt-dialog__error">{{ err | translate: locale.language }}</div>
        }
        <div class="prompt-dialog__actions">
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
      .prompt-dialog__backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.35);
        z-index: var(--si-z-dialog);
      }
      .prompt-dialog {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: calc(var(--si-z-dialog) + 1);
        min-width: 320px;
        max-width: 420px;
        padding: 18px 20px 14px;
        background: var(--si-bg1);
        border: 1px solid var(--si-border);
        border-radius: 10px;
        box-shadow: var(--si-shadow3);
      }
      .prompt-dialog__title {
        font-size: var(--si-text-11);
        font-weight: 600;
        color: var(--si-fg);
        margin-bottom: 8px;
      }
      .prompt-dialog__message {
        font-size: var(--si-text-8);
        color: var(--si-fg-muted);
        line-height: 1.45;
        margin-bottom: 10px;
      }
      .prompt-dialog__input {
        width: 100%;
        box-sizing: border-box;
        font: inherit;
        font-size: var(--si-text-8);
        padding: 8px 10px;
        background: var(--si-bg2);
        color: var(--si-fg);
        border: 1px solid var(--si-border);
        border-radius: 6px;
        margin-bottom: 4px;
        outline: none;
        transition: border-color 120ms ease;
      }
      .prompt-dialog__input:focus {
        border-color: color-mix(in srgb, var(--si-accent, #3b82f6) 60%, var(--si-border));
      }
      .prompt-dialog__error {
        font-size: var(--si-text-4);
        color: var(--si-rose, #c0392b);
        margin-bottom: 10px;
        margin-top: 4px;
      }
      .prompt-dialog__actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        margin-top: 14px;
      }
    `
  ]
})
export class PromptDialogComponent {
  private readonly service = inject(PromptDialogService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  @ViewChild('input') private input?: ElementRef<HTMLInputElement>

  protected readonly pending = this.service.pending
  protected readonly value = signal('')
  protected readonly errorMsg = signal<string | null>(null)

  constructor() {
    effect(() => {
      const p = this.pending()
      untracked(() => {
        if (p) {
          this.value.set(p.initialValue ?? '')
          this.errorMsg.set(null)
          queueMicrotask(() => this.focusInput(p.selectionRange ?? 'all'))
        } else {
          this.value.set('')
          this.errorMsg.set(null)
        }
      })
    })
  }

  protected canSubmit(): boolean {
    return this.pending() !== null && this.value().trim().length > 0 && this.errorMsg() === null
  }

  protected onInput(ev: Event): void {
    const next = (ev.target as HTMLInputElement).value
    this.value.set(next)
    const validate = this.pending()?.validate
    this.errorMsg.set(validate ? validate(next) : null)
  }

  protected onSubmit(ev: Event): void {
    ev.preventDefault()
    this.submit()
  }

  protected submit(): void {
    if (!this.canSubmit()) return
    const v = this.value().trim()
    const validate = this.pending()?.validate
    const err = validate ? validate(v) : null
    if (err) {
      this.errorMsg.set(err)
      return
    }
    this.service.resolve(v)
  }

  protected cancel(): void {
    this.service.resolve(null)
  }

  @HostListener('window:keydown.escape')
  onEscape(): void {
    if (this.pending()) this.cancel()
  }

  private focusInput(range: 'all' | 'stem'): void {
    const el = this.input?.nativeElement
    if (!el) return
    el.focus()
    if (range === 'all') {
      el.select()
    } else {
      // 'stem' — select up to the last dot, preserving extension
      const val = el.value
      const dot = val.lastIndexOf('.')
      const end = dot > 0 ? dot : val.length
      el.setSelectionRange(0, end)
    }
  }
}
