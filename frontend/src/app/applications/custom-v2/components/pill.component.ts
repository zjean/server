import { ChangeDetectionStrategy, Component, Input } from '@angular/core'

// 'indigo' and 'warm' are gone. Both resolved to the same accent values as
// 'amber', so the kit rendered three differently-named chips that were pixel
// identical — an API promising a distinction it could not deliver.
//
// 'accent' is new, because the design's "Shared · 3" badge is accent-tinted and
// there was no way to say that: 'amber' used to BE the accent, and once the accent
// moved to cobalt nothing spelled "brand tint" any more.
export type PillColor = 'gray' | 'green' | 'amber' | 'rose' | 'violet' | 'cyan' | 'accent'

// A badge is a 4px-radius rectangle; a chip is a full-radius lozenge. They are
// different shapes because they mean different things, and the design keeps them
// apart deliberately:
//
//   badge — a STATE the system is reporting. Favourite, Locked, Link, Shared · 3,
//           a comment count, a version number, Read-only. It lives in the row's
//           badge column and is not interactive.
//   chip  — a THING the user put there and can take away. Recipients in the share
//           dialog, an active search filter. Usually carries a dismiss affordance.
//
// `badge` is the default. Everything used to be the lozenge, which made every
// reported state look removable.
export type PillShape = 'badge' | 'chip'

@Component({
  selector: 'app-v2-pill',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="pill" [class]="'pill--' + color + ' pill--' + shape" [style.font-size.px]="size"><ng-content /></span>`,
  styles: [
    `
      :host {
        display: inline-flex;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: var(--si-space-3);
        line-height: 1;
        font-family: var(--si-sans);
        font-weight: 500;
        white-space: nowrap;
        letter-spacing: -0.05px;
      }
      .pill--badge {
        padding: var(--si-space-2) var(--si-space-4);
        border-radius: var(--si-r0);
      }
      .pill--chip {
        padding: var(--si-space-3) var(--si-space-5);
        border-radius: var(--si-r4);
      }

      /* Every variant is a soft fill plus the matching -ink tone as type. Filling
         a shape takes the base tone; drawing a word takes -ink. Getting that
         backwards is what made two of these fail AA in an earlier revision. The
         borders are gone: a 1px edge in the same colour as the fill is invisible,
         and in a different colour it fights the badge column's rhythm. */
      .pill--gray {
        background: var(--si-neutral-soft);
        color: var(--si-neutral-ink);
      }
      .pill--green {
        background: var(--si-green-soft);
        color: var(--si-green-ink);
      }
      /* Amber's ink used to be --si-accent-ink, from when the accent WAS the warm
         tone and "amber" was its alias. Once the accent became cobalt that left
         blue text on an amber fill — plausible in a diff, wrong on screen. */
      .pill--amber {
        background: var(--si-amber-soft);
        color: var(--si-amber-ink);
      }
      .pill--rose {
        background: var(--si-rose-soft);
        color: var(--si-rose-ink);
      }
      .pill--violet {
        background: var(--si-violet-soft);
        color: var(--si-violet-ink);
      }
      .pill--cyan {
        background: var(--si-cyan-soft);
        color: var(--si-cyan-ink);
      }
      .pill--accent {
        background: var(--si-accent-soft);
        color: var(--si-accent-ink);
      }
    `
  ]
})
export class PillComponent {
  @Input() color: PillColor = 'violet'
  @Input() shape: PillShape = 'badge'
  @Input() size = 11
}
