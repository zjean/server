import { ChangeDetectionStrategy, Component, computed, HostListener, inject } from '@angular/core'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { ButtonComponent } from './button.component'
import { ConfirmDialogService } from './confirm-dialog.service'

@Component({
  selector: 'app-v2-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, L10nTranslatePipe],
  template: `
    @if (pending(); as p) {
      <div class="confirm-dialog__backdrop" (click)="cancel()" (contextmenu)="$event.preventDefault()"></div>
      <div class="confirm-dialog" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
        <div class="confirm-dialog__title">{{ p.title | translate: locale.language }}</div>
        <div class="confirm-dialog__message" [innerHTML]="p.message | translate: locale.language : p.messageParams"></div>
        <div class="confirm-dialog__actions">
          <app-v2-btn kind="ghost" size="sm" (click)="cancel()">
            {{ p.cancelLabel ?? 'Cancel' | translate: locale.language }}
          </app-v2-btn>
          <app-v2-btn [kind]="p.kind === 'danger' ? 'danger' : 'primary'" size="sm" (click)="confirm()">
            {{ p.confirmLabel | translate: locale.language }}
          </app-v2-btn>
        </div>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }
      .confirm-dialog__backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.35);
        z-index: var(--si-z-dialog);
      }
      .confirm-dialog {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: calc(var(--si-z-dialog) + 1);
        min-width: 320px;
        max-width: 420px;
        padding: var(--si-space-9) var(--si-space-10) var(--si-space-7);
        background: var(--si-bg1);
        border: 1px solid var(--si-border);
        border-radius: 10px;
        box-shadow: var(--si-shadow3);
      }
      .confirm-dialog__title {
        font-size: var(--si-text-11);
        font-weight: 600;
        color: var(--si-fg);
        margin-bottom: var(--si-space-4);
      }
      .confirm-dialog__message {
        font-size: var(--si-text-8);
        color: var(--si-fg-muted);
        line-height: 1.45;
        margin-bottom: var(--si-space-8);
      }
      .confirm-dialog__message ::ng-deep b {
        color: var(--si-fg);
        font-weight: 600;
      }
      .confirm-dialog__actions {
        display: flex;
        gap: var(--si-space-4);
        justify-content: flex-end;
      }
    `
  ]
})
export class ConfirmDialogComponent {
  private readonly service = inject(ConfirmDialogService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  protected readonly pending = computed(() => this.service.pending())

  protected cancel(): void {
    this.service.resolve(false)
  }

  protected confirm(): void {
    this.service.resolve(true)
  }

  @HostListener('window:keydown.escape')
  onEscape(): void {
    if (this.pending()) this.cancel()
  }

  @HostListener('window:keydown.enter')
  onEnter(): void {
    if (this.pending()) this.confirm()
  }
}
