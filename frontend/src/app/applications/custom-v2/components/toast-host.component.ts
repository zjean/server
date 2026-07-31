import { ChangeDetectionStrategy, Component, HostListener, inject } from '@angular/core'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { IconV2Component } from '../icons/icon-v2.component'
import { ToastService } from './toast.service'

@Component({
  selector: 'app-v2-toast-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconV2Component, L10nTranslatePipe],
  template: `
    <div class="toast-host" aria-live="polite">
      @for (t of toasts(); track t.id) {
        <div class="toast toast--{{ t.kind }}" role="status">
          <app-v2-icon [name]="t.kind === 'error' ? 'x' : 'check'" [size]="14" />
          <span class="toast__msg">{{ t.message | translate: locale.language }}</span>
          <button type="button" class="toast__close" (click)="dismiss(t.id)" [attr.aria-label]="'Dismiss' | translate: locale.language">
            <app-v2-icon name="x" [size]="12" />
          </button>
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        position: fixed;
        top: 60px;
        right: 16px;
        z-index: var(--si-z-toast);
        pointer-events: none;
      }
      .toast-host {
        display: flex;
        flex-direction: column;
        gap: var(--si-space-4);
      }
      .toast {
        pointer-events: auto;
        display: inline-flex;
        align-items: center;
        gap: var(--si-space-4);
        min-width: 220px;
        max-width: 360px;
        padding: var(--si-space-4) var(--si-space-5);
        border-radius: 8px;
        background: var(--si-bg1);
        border: 1px solid var(--si-border);
        box-shadow: var(--si-shadow2);
        color: var(--si-fg);
        font-size: var(--si-text-8);
        animation: toast-in 140ms ease-out;
      }
      .toast--success {
        border-color: color-mix(in srgb, var(--si-green) 35%, var(--si-border));
      }
      .toast--success app-v2-icon {
        color: var(--si-green);
      }
      .toast--error {
        border-color: color-mix(in srgb, var(--si-rose) 35%, var(--si-border));
      }
      .toast--error app-v2-icon {
        color: var(--si-rose-ink);
      }
      .toast__msg {
        flex: 1 1 auto;
        min-width: 0;
        word-break: break-word;
      }
      .toast__close {
        background: transparent;
        border: none;
        color: var(--si-fg-muted);
        cursor: pointer;
        padding: var(--si-space-1);
        border-radius: 4px;
        display: inline-flex;
      }
      .toast__close:hover {
        background: var(--si-bg3);
        color: var(--si-fg);
      }
      @keyframes toast-in {
        from {
          opacity: 0;
          transform: translateY(-4px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
    `
  ]
})
export class ToastHostComponent {
  private readonly service = inject(ToastService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  protected readonly toasts = this.service.toasts.asReadonly()

  protected dismiss(id: number): void {
    this.service.dismiss(id)
  }

  @HostListener('window:keydown.escape')
  onEscape(): void {
    this.service.dismissAll()
  }
}
