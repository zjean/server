import { HttpHeaders } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, effect, ElementRef, HostListener, inject, untracked, ViewChild } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { TWO_FA_CODE_LENGTH, TWO_FA_HEADER_CODE, TWO_FA_HEADER_PASSWORD } from '@sync-in-server/backend/src/authentication/constants/auth'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { ButtonComponent } from './button.component'
import { TwoFaDialogService } from './two-fa-dialog.service'

@Component({
  selector: 'app-v2-2fa-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, FormsModule, L10nTranslateDirective, L10nTranslatePipe],
  template: `
    @if (pending(); as p) {
      <div class="v2-dialog-backdrop" (click)="cancel()"></div>
      <form class="v2-dialog tfa-dialog" role="dialog" aria-modal="true" (click)="$event.stopPropagation()" (submit)="onSubmit($event)">
        <div class="v2-dialog__head">
          <div class="v2-dialog__title">
            @if (p.withTotp) {
              <span l10nTranslate>Two-Factor Authentication</span>
            } @else {
              <span l10nTranslate>Password Authentication</span>
            }
          </div>
        </div>
        <div class="v2-dialog__body tfa-dialog__body">
          @if (p.withPassword) {
            <label class="tfa-dialog__field">
              <span l10nTranslate>Enter your password</span>
              <input
                #passwordInput
                type="password"
                class="tfa-dialog__input"
                autocomplete="current-password"
                [(ngModel)]="password"
                [ngModelOptions]="{ standalone: true }"
              />
            </label>
          }
          @if (p.withTotp) {
            <label class="tfa-dialog__field">
              <span l10nTranslate>Valid with your TOTP code</span>
              <input
                #totpInput
                type="text"
                class="tfa-dialog__input tfa-dialog__input--totp"
                inputmode="numeric"
                autocomplete="one-time-code"
                [maxlength]="TWO_FA_CODE_LENGTH"
                [placeholder]="'••••••'"
                [(ngModel)]="totpCode"
                [ngModelOptions]="{ standalone: true }"
              />
            </label>
          }
        </div>
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
      /* Frame, scrim, head, body and footer come from styles/_dialog.scss. */
      :host {
        display: contents;
      }
      .tfa-dialog__body {
        display: flex;
        flex-direction: column;
        gap: var(--si-space-6);
      }
      .tfa-dialog__field {
        display: flex;
        flex-direction: column;
        gap: var(--si-space-2);
      }
      .tfa-dialog__field > span {
        font-size: var(--si-text-3);
        text-transform: uppercase;
        letter-spacing: 1px;
        color: var(--si-fg-muted);
        font-weight: 600;
      }
      .tfa-dialog__input {
        width: 100%;
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
      .tfa-dialog__input:focus {
        border-color: color-mix(in srgb, var(--si-accent) 60%, var(--si-border));
      }
      .tfa-dialog__input--totp {
        text-align: center;
        letter-spacing: 4px;
        font-family: var(--si-mono);
      }
    `
  ]
})
export class TwoFaDialogComponent {
  private readonly service = inject(TwoFaDialogService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  protected readonly TWO_FA_CODE_LENGTH = TWO_FA_CODE_LENGTH

  @ViewChild('passwordInput') private passwordInput?: ElementRef<HTMLInputElement>
  @ViewChild('totpInput') private totpInput?: ElementRef<HTMLInputElement>

  protected readonly pending = this.service.pending
  protected password = ''
  protected totpCode = ''
  private readonly totpPattern = new RegExp(`^\\d{${TWO_FA_CODE_LENGTH}}$`)

  constructor() {
    effect(() => {
      const p = this.pending()
      untracked(() => {
        this.password = ''
        this.totpCode = ''
        if (p) {
          queueMicrotask(() => this.focusFirst(p.withPassword))
        }
      })
    })
  }

  protected canSubmit(): boolean {
    const p = this.pending()
    if (!p) return false
    if (p.withPassword && this.password.length === 0) return false
    if (p.withTotp && !this.totpPattern.test(this.totpCode)) return false
    return true
  }

  protected onSubmit(ev: Event): void {
    ev.preventDefault()
    this.submit()
  }

  protected submit(): void {
    const p = this.pending()
    if (!p || !this.canSubmit()) return
    const headers = new HttpHeaders({
      ...(p.withTotp ? { [TWO_FA_HEADER_CODE]: this.totpCode } : {}),
      ...(p.withPassword ? { [TWO_FA_HEADER_PASSWORD]: this.password } : {})
    })
    this.service.resolve(headers)
  }

  protected cancel(): void {
    this.service.resolve(false)
  }

  @HostListener('window:keydown.escape')
  onEscape(): void {
    if (this.pending()) this.cancel()
  }

  private focusFirst(withPassword: boolean): void {
    const el = withPassword ? this.passwordInput?.nativeElement : this.totpInput?.nativeElement
    el?.focus()
  }
}
