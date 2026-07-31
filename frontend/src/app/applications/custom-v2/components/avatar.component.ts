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

  // L 0.545 → 0.445 at C 0.075, with the initials at L 0.975. The previous
  // ramp (0.55 → 0.38 at C 0.14) put white-ish initials on a mid tone of
  // 4.1–4.4:1 — under AA — and at that chroma the hues around 60–130 landed in
  // olive mud. Across the eight stops avatarHue() can now return, the worst
  // initial measures 5.51:1.
  readonly backgroundStyle = computed(() => {
    const hue = this.user().hue
    return `linear-gradient(135deg, oklch(0.545 0.075 ${hue}), oklch(0.445 0.07 ${hue}))`
  })

  readonly fgColor = computed(() => `oklch(0.975 0.008 ${this.user().hue})`)

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

// Eight curated stops rather than the full 0–360 wheel. An unbounded hue let
// avatars import arbitrary colour into a palette that is otherwise budgeted,
// and the band around 60–130 rendered as olive mud at any usable lightness.
// These eight are evenly spread enough to stay tellable apart, and each one is
// a hue the rest of the system already speaks (brand 62, data 150, docs 235,
// media 295, danger 25).
export const AVATAR_HUES = [22, 62, 150, 195, 235, 268, 295, 335] as const

export function avatarHue(seed: string): number {
  let h = 5381
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h) ^ seed.charCodeAt(i)
  return AVATAR_HUES[Math.abs(h) % AVATAR_HUES.length]
}
