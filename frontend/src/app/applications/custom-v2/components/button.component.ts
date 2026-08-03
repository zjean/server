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
        gap: var(--si-space-3);
      }
      .btn--sm {
        height: 28px;
        padding: 0 11px;
        font-size: var(--si-text-9);
        gap: var(--si-space-3);
      }
      .btn--md {
        height: 32px;
        padding: 0 13px;
        font-size: var(--si-text-10);
        gap: var(--si-space-4);
      }
      .btn--lg {
        height: 38px;
        padding: 0 var(--si-space-9);
        font-size: var(--si-text-10);
        gap: var(--si-space-4);
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
      // Filled surface-3, no border. The design's secondary is a solid step above
      // the content plane; an outline here made it read as a disabled outline
      // button next to the filled primary. This lands in the token PR rather than
      // with the rest of the button work because it is a token-mapping fix: the
      // old value only looked right against the old ramp, where bg4 was light
      // enough to read as a fill on its own.
      .btn--secondary {
        background: var(--si-bg5);
        color: var(--si-fg);
        border-color: transparent;
      }
      .btn--secondary:hover:not(:disabled) {
        background: var(--si-bg6);
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
      // Deliberately a soft tint, never a filled rose — a destructive action
      // must not carry the same visual weight as the primary next to it. That
      // was already true; what was not is that these three values were literal
      // oklch at hue 20 while the rose token lives at hue 25, so the variant
      // drifted out of the palette. Now routed through the tokens: rose-ink on
      // rose-soft measures 5.59:1 over bg2.
      .btn--danger {
        background: var(--si-rose-soft);
        color: var(--si-rose-ink);
        border-color: color-mix(in srgb, var(--si-rose) 35%, transparent);
      }
      .btn--danger:hover:not(:disabled) {
        background: color-mix(in srgb, var(--si-rose) 26%, transparent);
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
