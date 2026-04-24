import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core'

export type CheckboxState = 'checked' | 'unchecked' | 'indeterminate'

@Component({
  selector: 'app-v2-checkbox',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="v2-checkbox"
      [class.v2-checkbox--checked]="state === 'checked'"
      [class.v2-checkbox--indeterminate]="state === 'indeterminate'"
      [attr.aria-checked]="state === 'indeterminate' ? 'mixed' : state === 'checked'"
      [attr.aria-label]="ariaLabel"
      role="checkbox"
      (click)="onClick($event)"
    >
      @if (state === 'checked') {
        <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
          <path d="M3 8.5 L6.5 12 L13 4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      } @else if (state === 'indeterminate') {
        <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
          <path d="M3.5 8 L12.5 8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
        </svg>
      }
    </button>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
      }
      .v2-checkbox {
        width: 16px;
        height: 16px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 4px;
        border: 1.5px solid var(--si-line-strong, var(--si-line));
        background: transparent;
        color: transparent;
        cursor: pointer;
        padding: 0;
        transition:
          background 120ms ease,
          border-color 120ms ease,
          color 120ms ease;
      }
      .v2-checkbox:hover {
        border-color: var(--si-fg-muted);
      }
      .v2-checkbox:focus-visible {
        outline: 2px solid var(--si-nav);
        outline-offset: 2px;
      }
      .v2-checkbox--checked,
      .v2-checkbox--indeterminate {
        background: var(--si-nav);
        border-color: var(--si-nav);
        color: #fff;
      }
      .v2-checkbox--checked:hover,
      .v2-checkbox--indeterminate:hover {
        filter: brightness(1.08);
      }
    `
  ]
})
export class CheckboxComponent {
  @Input() state: CheckboxState = 'unchecked'
  @Input() ariaLabel = 'Select'
  @Output() toggled = new EventEmitter<MouseEvent>()

  onClick(event: MouseEvent): void {
    event.stopPropagation()
    event.preventDefault()
    this.toggled.emit(event)
  }
}
