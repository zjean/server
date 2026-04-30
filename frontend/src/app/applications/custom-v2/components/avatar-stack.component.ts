import { ChangeDetectionStrategy, Component, computed, Input, input } from '@angular/core'
import { AvatarComponent, AvatarUser } from './avatar.component'

export interface AvatarStackUser extends AvatarUser {
  id: string | number
}

@Component({
  selector: 'app-v2-avatar-stack',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent],
  template: `
    <div class="stack">
      @for (u of shown(); track u.id; let i = $index) {
        <div class="slot" [style.margin-left.px]="i === 0 ? 0 : -6">
          <app-v2-avatar [user]="u" [size]="size()" [ring]="'var(--si-bg3)'" />
        </div>
      }
      @if (extraCount() > 0) {
        <div
          class="extra"
          [style.width.px]="size()"
          [style.height.px]="size()"
          [style.border-radius.px]="size()"
          [style.font-size.px]="extraFontSize()"
        >
          +{{ extraCount() }}
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        flex-shrink: 0;
      }
      .stack {
        display: flex;
        align-items: center;
      }
      .extra {
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--si-bg4);
        color: var(--si-fg-muted);
        font-family: var(--si-sans);
        font-weight: 600;
        margin-left: -6px;
        box-shadow: 0 0 0 2px var(--si-bg3);
      }
    `
  ]
})
export class AvatarStackComponent {
  readonly users = input.required<AvatarStackUser[]>()
  readonly size = input<number>(22)
  // Optional override for the overflow count. When provided (e.g. a space card
  // knows the total member count but only has avatar identities for managers),
  // the "+N" chip is computed against `total` instead of users.length.
  readonly total = input<number | undefined>(undefined)
  @Input() max = 3

  readonly shown = computed(() => this.users().slice(0, this.max))
  readonly extraCount = computed(() => {
    const total = this.total()
    const visible = this.shown().length
    return total === undefined ? Math.max(0, this.users().length - visible) : Math.max(0, total - visible)
  })
  readonly extraFontSize = computed(() => Math.round(this.size() * 0.4 * 10) / 10)
}
