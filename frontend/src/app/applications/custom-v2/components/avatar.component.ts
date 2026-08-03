import { ChangeDetectionStrategy, Component, computed, Input, input } from '@angular/core'

export interface AvatarUser {
  initials: string
  // Index into the six --si-avatar-* tones, 1-based. Produced by avatarTone()
  // so one login renders identically everywhere.
  tone: number
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
      [style.background]="toneVar('')"
      [style.color]="toneVar('-fg')"
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

  // Flat tone, not a gradient. The previous avatar was a two-stop oklch gradient
  // built from a per-user hue; both halves of that are gone. The gradient because
  // this system builds depth from surface steps rather than from shading, and the
  // computed hue because it let a login choose a colour the palette had not
  // budgeted for. See the --si-avatar-* block in _tokens.scss.
  protected toneVar(suffix: string): string {
    const n = clampTone(this.user().tone)
    return `var(--si-avatar-${n}${suffix})`
  }

  readonly fontSize = computed(() => Math.round(this.size() * 0.38 * 10) / 10)

  // Stacked avatars carry a 2px ring in the surface colour behind them, so the
  // overlap reads as separation rather than as a merge. There is no default ring:
  // a single avatar sits on the surface unringed.
  readonly ringStyle = computed(() => (this.ring ? `0 0 0 2px ${this.ring}` : 'none'))
}

// Shared seed → avatar helpers. Used by every place that builds an
// AvatarUser entry so a given login renders the same gradient + initials
// across the user-card, manager stacks on Space cards, comment threads, etc.
export function avatarInitials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return (parts[0]?.slice(0, 2) ?? '··').toUpperCase()
}

// Six tones, matching the --si-avatar-* tokens. Six rather than eight because
// every tone has to be a member of the system's own palette AND carry a measured
// ink pairing; there is no seventh colour in the system that qualifies.
export const AVATAR_TONE_COUNT = 6

const clampTone = (n: number): number => (Number.isInteger(n) && n >= 1 && n <= AVATAR_TONE_COUNT ? n : 1)

// djb2. Stable across reloads and processes — that is the whole requirement, and
// it is why this is not `Math.random()` or an id modulus (ids are dense, so a
// modulus made adjacent users adjacent tones).
export function avatarTone(seed: string): number {
  let h = 5381
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h) ^ seed.charCodeAt(i)
  return (Math.abs(h) % AVATAR_TONE_COUNT) + 1
}
