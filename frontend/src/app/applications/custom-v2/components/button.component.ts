import { ChangeDetectionStrategy, Component, Input } from '@angular/core'
import { IconV2Component, IconV2Name } from '../icons/icon-v2.component'

export type ButtonKind = 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger' | 'danger-filled'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

// The design's button hierarchy, in its own words: one primary per view;
// secondary for the two next-most-likely actions; ghost for everything else;
// icon-only only when the glyph is unambiguous AND tooltipped.
//
// Two rules govern every state below and are easy to break by accident:
//   • Hover is always a surface step up; active is a surface step plus a 1px
//     inset. NO CONTROL EVER MOVES ON PRESS. No translate, no scale.
//   • The primary is a flat fill. It carried a border and a shadow before, which
//     is a bevel by another name — this system builds depth from surface steps.
//
// Sizes are the design's 32 / 36 / 44 (sm / md / lg). Desktop uses md; touch
// targets are never below 44. `xs` at 28px is ours and off the design's ladder,
// kept for dense table rows where 32 does not fit — reach for it rarely.
@Component({
  selector: 'app-v2-btn',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconV2Component],
  template: `
    <button
      type="button"
      class="btn"
      [class]="'btn--' + kind + ' btn--' + size"
      [class.btn--loading]="loading"
      [disabled]="disabled || loading"
      [attr.title]="title"
      [attr.aria-busy]="loading ? 'true' : null"
    >
      @if (loading) {
        <span class="btn__spinner" aria-hidden="true"></span>
      } @else if (icon) {
        <app-v2-icon [name]="icon" [size]="iconPx" />
      }
      <ng-content />
      @if (iconRight && !loading) {
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
        border-radius: var(--si-r1);
        font-family: var(--si-sans);
        font-weight: 500;
        letter-spacing: -0.05px;
        cursor: pointer;
        white-space: nowrap;
        transition:
          background var(--si-dur-2) var(--si-ease-out),
          border-color var(--si-dur-2) var(--si-ease-out),
          color var(--si-dur-2) var(--si-ease-out);
      }
      .btn:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }
      /* Loading keeps the label so the button does not resize mid-action, which
         would move whatever sits beside it. */
      .btn--loading {
        cursor: progress;
        opacity: 1;
      }
      .btn__spinner {
        width: 1em;
        height: 1em;
        border-radius: var(--si-r4);
        border: 1.5px solid currentColor;
        border-top-color: transparent;
        animation: btn-spin 700ms linear infinite;
        flex: none;
      }
      @keyframes btn-spin {
        to {
          transform: rotate(360deg);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .btn__spinner {
          animation-duration: 1.6s;
        }
      }

      .btn--xs {
        height: 28px;
        padding: 0 var(--si-space-5);
        font-size: var(--si-text-7);
        gap: var(--si-space-3);
      }
      .btn--sm {
        height: 32px;
        padding: 0 var(--si-space-6);
        font-size: var(--si-text-7);
        gap: var(--si-space-3);
      }
      .btn--md {
        height: 36px;
        padding: 0 var(--si-space-7);
        font-size: var(--si-text-8);
        gap: var(--si-space-4);
      }
      .btn--lg {
        height: 44px;
        padding: 0 var(--si-space-9);
        font-size: var(--si-text-10);
        gap: var(--si-space-4);
      }

      /* One filled cobalt action per view. */
      .btn--primary {
        background: var(--si-accent);
        color: var(--si-accent-fg);
      }
      .btn--primary:hover:not(:disabled) {
        background: var(--si-accent-hover);
      }
      .btn--primary:active:not(:disabled) {
        background: var(--si-accent-deep);
        box-shadow: var(--si-shadow-press);
      }

      .btn--secondary {
        background: var(--si-bg5);
        color: var(--si-fg);
      }
      .btn--secondary:hover:not(:disabled) {
        background: var(--si-bg6);
      }
      .btn--secondary:active:not(:disabled) {
        box-shadow: var(--si-shadow-press);
      }

      .btn--ghost {
        background: transparent;
        color: var(--si-fg-muted);
      }
      .btn--ghost:hover:not(:disabled) {
        background: var(--si-bg3);
        color: var(--si-fg);
      }
      .btn--ghost:active:not(:disabled) {
        background: var(--si-bg5);
      }

      .btn--outline {
        background: transparent;
        color: var(--si-fg);
        border-color: var(--si-border);
      }
      .btn--outline:hover:not(:disabled) {
        background: var(--si-bg3);
      }

      /* Danger comes in two weights, and which one you use is a semantic choice,
         not a styling one. The quiet tint belongs in menus and toolbars, where a
         destructive action must not carry the primary's weight. The filled one is
         CONFIRM ONLY: it is the button in the dialog that already told the user
         what is about to happen.
         (No backticks in comments inside these template literals — a backtick
         terminates the literal and the styles array stops being statically
         analysable, which fails the build with a message that names no file.) */
      .btn--danger {
        background: var(--si-rose-soft);
        color: var(--si-rose-ink);
      }
      .btn--danger:hover:not(:disabled) {
        background: color-mix(in srgb, var(--si-rose) 26%, transparent);
      }
      .btn--danger-filled {
        background: var(--si-rose);
        color: var(--si-rose-fg);
      }
      .btn--danger-filled:hover:not(:disabled) {
        background: color-mix(in srgb, var(--si-rose) 86%, var(--si-fg));
      }
      .btn--danger-filled:active:not(:disabled) {
        box-shadow: var(--si-shadow-press);
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
  @Input() loading = false
  @Input() title: string | null = null

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
