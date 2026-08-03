import { ChangeDetectionStrategy, Component, Input } from '@angular/core'
import { IconV2Component, IconV2Name } from '../icons/icon-v2.component'

@Component({
  selector: 'app-v2-icon-btn',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconV2Component],
  template: `
    <button
      type="button"
      class="icon-btn"
      [class.icon-btn--active]="active"
      [style.width.px]="size"
      [style.height.px]="size"
      [style.color]="color"
      [attr.title]="title"
      [attr.aria-label]="resolvedAriaLabel"
      [disabled]="disabled"
    >
      <app-v2-icon [name]="iconName" [size]="resolvedIconSize" />
    </button>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
      }
      .icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        color: var(--si-fg-muted);
        border: none;
        border-radius: 6px;
        cursor: pointer;
        flex-shrink: 0;
        padding: 0;
        transition:
          background 120ms ease,
          color 120ms ease;
      }
      .icon-btn:hover:not(:disabled) {
        background: var(--si-bg3);
        color: var(--si-fg);
      }
      .icon-btn--active {
        background: var(--si-bg3);
        color: var(--si-fg);
      }
      .icon-btn:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }
    `
  ]
})
export class IconButtonComponent {
  @Input({ required: true }) iconName!: IconV2Name
  @Input() size = 30
  @Input() iconSize: number | null = null
  @Input() active = false
  @Input() color: string | null = null
  @Input() title: string | null = null
  // The button's content is one <svg>, so there is no text node to name it —
  // without this (or a `title`) it announces as a bare "button". Defaults to
  // `title` because every call site that has one already spells the action out
  // there, and a tooltip is not an accessible name: AT exposes `title` only as
  // a last-resort fallback, and never at all once aria-label is present.
  @Input() ariaLabel: string | null = null
  @Input() disabled = false

  get resolvedIconSize(): number {
    return this.iconSize ?? Math.round(this.size * 0.52)
  }

  get resolvedAriaLabel(): string | null {
    return this.ariaLabel ?? this.title
  }
}
