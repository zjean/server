import { ChangeDetectionStrategy, Component, computed, Input, input } from '@angular/core'

export interface AvatarUser {
  initials: string
  hue: number
  // Optional image URL — when present, the avatar renders the image and the
  // initials are kept as alt text. Used by the left-nav user-card to keep
  // showing real user-avatar PNGs while sharing the AvatarStack rendering
  // path everywhere else.
  imageUrl?: string | null
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
      @if (user().imageUrl) {
        <img class="avatar__img" [src]="user().imageUrl!" [alt]="user().initials" />
      } @else {
        {{ user().initials }}
      }
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
        overflow: hidden;
      }
      .avatar__img {
        width: 100%;
        height: 100%;
        object-fit: cover;
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

// Shared seed → avatar helpers. Used by every place that builds an
// AvatarUser entry so a given login renders the same gradient + initials
// across the user-card, manager stacks on Space cards, comment threads, etc.
export function avatarInitials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return (parts[0]?.slice(0, 2) ?? '··').toUpperCase()
}

export function avatarHue(seed: string): number {
  let h = 5381
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h) ^ seed.charCodeAt(i)
  return Math.abs(h) % 360
}
