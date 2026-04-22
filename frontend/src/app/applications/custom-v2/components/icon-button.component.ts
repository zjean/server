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
        background: var(--si-bg4);
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
  @Input() disabled = false

  get resolvedIconSize(): number {
    return this.iconSize ?? Math.round(this.size * 0.52)
  }
}
