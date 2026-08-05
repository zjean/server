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
      <div class="v2-dialog-backdrop" (click)="cancel()"></div>
      <form class="v2-dialog prompt-dialog" role="dialog" aria-modal="true" (click)="$event.stopPropagation()" (submit)="onSubmit($event)">
        <div class="v2-dialog__head">
          <div class="v2-dialog__title">{{ p.title | translate: locale.language }}</div>
        </div>
        <div class="v2-dialog__body">
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
        </div>
        @if (errorMsg(); as err) {
          <div class="v2-dialog__error">{{ err | translate: locale.language }}</div>
        }
        <div class="v2-dialog__footer">
          <div class="v2-dialog__spacer"></div>
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
      /* Frame, scrim, head, body, error and footer come from styles/_dialog.scss. */
      :host {
        display: contents;
      }
      .prompt-dialog__message {
        font-size: var(--si-text-8);
        color: var(--si-fg-muted);
        line-height: 1.45;
        margin-bottom: var(--si-space-5);
      }
      .prompt-dialog__input {
        width: 100%;
        box-sizing: border-box;
        font: inherit;
        font-size: var(--si-text-8);
        padding: var(--si-space-4) var(--si-space-5);
        /* bg3 is the input fill. It was bg2, which was one step down from the old
           bg1 frame; on the bg5 frame that reads as a hole rather than a field. */
        background: var(--si-bg3);
        color: var(--si-fg);
        border: 1px solid var(--si-border);
        border-radius: var(--si-r1);
        outline: none;
        transition: border-color 120ms ease;
      }
      .prompt-dialog__input:focus {
        border-color: color-mix(in srgb, var(--si-accent) 60%, var(--si-border));
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
