import { ChangeDetectionStrategy, Component, Input } from '@angular/core'
import { IconV2Component, IconV2Name } from '../icons/icon-v2.component'

export type ButtonKind = 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

@Component({
  selector: 'app-v2-btn',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconV2Component],
  template: `
    <button type="button" class="btn" [class]="'btn--' + kind + ' btn--' + size" [disabled]="disabled" [attr.title]="title">
      @if (icon) {
        <app-v2-icon [name]="icon" [size]="iconPx" />
      }
      <ng-content />
      @if (iconRight) {
        <app-v2-icon [name]="iconRight" [size]="iconPx" />
      }
    </button>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
      }
      .btn {
        display: inline-flex;
        align-items: center;
        border: 1px solid transparent;
        border-radius: 7px;
        font-family: var(--si-sans);
        font-weight: 500;
        letter-spacing: -0.05px;
        cursor: pointer;
        white-space: nowrap;
        transition:
          background 120ms ease,
          border-color 120ms ease,
          color 120ms ease;
      }
      .btn:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }

      .btn--xs {
        height: 24px;
        padding: 0 9px;
        font-size: var(--si-text-7);
        gap: 5px;
      }
      .btn--sm {
        height: 28px;
        padding: 0 11px;
        font-size: var(--si-text-9);
        gap: 6px;
      }
      .btn--md {
        height: 32px;
        padding: 0 13px;
        font-size: var(--si-text-10);
        gap: 7px;
      }
      .btn--lg {
        height: 38px;
        padding: 0 18px;
        font-size: var(--si-text-10);
        gap: 8px;
      }

      .btn--primary {
        background: var(--si-accent);
        color: var(--si-accent-fg);
        border-color: var(--si-accent-line);
        box-shadow: var(--si-shadow1);
      }
      .btn--primary:hover {
        background: var(--si-accent-hover);
      }
      .btn--secondary {
        background: var(--si-bg4);
        color: var(--si-fg);
        border-color: var(--si-line-strong);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
      }
      .btn--ghost {
        background: transparent;
        color: var(--si-fg-muted);
      }
      .btn--ghost:hover:not(:disabled) {
        background: var(--si-bg3);
        color: var(--si-fg);
      }
      .btn--outline {
        background: transparent;
        color: var(--si-fg);
        border-color: var(--si-line-strong);
      }
      .btn--outline:hover:not(:disabled) {
        background: var(--si-bg3);
      }
      .btn--danger {
        background: oklch(0.7 0.17 20 / 0.16);
        color: oklch(0.88 0.15 20);
        border-color: oklch(0.7 0.17 20 / 0.35);
      }
    `
  ]
})
export class ButtonComponent {
  @Input() kind: ButtonKind = 'ghost'
  @Input() size: ButtonSize = 'md'
  @Input() icon: IconV2Name | null = null
  @Input() iconRight: IconV2Name | null = null
  @Input() disabled = false
  @Input() title: string | null = null

  // Icon size scales loosely with button size; chrome.jsx doesn't pass one explicitly.
  get iconPx(): number {
    switch (this.size) {
      case 'xs':
        return 13
      case 'sm':
        return 14
      case 'lg':
        return 17
      default:
        return 15
    }
  }
}
