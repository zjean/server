import { ChangeDetectionStrategy, Component, computed, Input, input } from '@angular/core'

export interface AvatarUser {
  initials: string
  hue: number
}

@Component({
  selector: 'app-v2-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="avatar"
      [style.width.px]="size()"
      [style.height.px]="size()"
      [style.border-radius.px]="size()"
      [style.background]="backgroundStyle()"
      [style.color]="fgColor()"
      [style.font-size.px]="fontSize()"
      [style.box-shadow]="ringStyle()"
    >
      {{ user().initials }}
    </span>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        flex-shrink: 0;
      }
      .avatar {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-family: var(--si-sans);
        font-weight: 600;
        letter-spacing: -0.3px;
        flex-shrink: 0;
      }
    `
  ]
})
export class AvatarComponent {
  readonly user = input.required<AvatarUser>()
  readonly size = input<number>(24)
  @Input() ring: string | null = null

  readonly backgroundStyle = computed(() => {
    const hue = this.user().hue
    return `linear-gradient(135deg, oklch(0.55 0.14 ${hue}), oklch(0.38 0.12 ${hue}))`
  })

  readonly fgColor = computed(() => `oklch(0.96 0.03 ${this.user().hue})`)

  readonly fontSize = computed(() => Math.round(this.size() * 0.38 * 10) / 10)

  readonly ringStyle = computed(() => (this.ring ? `0 0 0 2px ${this.ring}` : 'inset 0 1px 0 rgba(255,255,255,0.12)'))
}
