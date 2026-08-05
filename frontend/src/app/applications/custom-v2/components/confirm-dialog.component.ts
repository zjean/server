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
      <div class="v2-dialog-backdrop" (click)="cancel()" (contextmenu)="$event.preventDefault()"></div>
      <div class="v2-dialog confirm-dialog" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
        <div class="v2-dialog__head">
          <div class="v2-dialog__title">{{ p.title | translate: locale.language }}</div>
        </div>
        <div class="v2-dialog__body">
          <div class="confirm-dialog__message" [innerHTML]="p.message | translate: locale.language : p.messageParams"></div>
        </div>
        <div class="v2-dialog__footer">
          <div class="v2-dialog__spacer"></div>
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
      /* Frame, scrim, head, body and footer all come from styles/_dialog.scss —
         see its header for why they are global classes rather than a mixin. What
         is left here is only what is specific to a confirm. */
      :host {
        display: contents;
      }
      .confirm-dialog__message {
        font-size: var(--si-text-8);
        color: var(--si-fg-muted);
        line-height: 1.45;
      }
      .confirm-dialog__message ::ng-deep b {
        color: var(--si-fg);
        font-weight: 600;
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
