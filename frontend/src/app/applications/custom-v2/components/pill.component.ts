import { ChangeDetectionStrategy, Component, Input } from '@angular/core'

// 'indigo' and 'warm' are gone. Both resolved to the same accent values as
// 'amber', so the kit rendered three differently-named chips that were pixel
// identical — an API promising a distinction it could not deliver. 'amber' is
// the surviving name for the brand-tinted pill.
export type PillColor = 'gray' | 'green' | 'amber' | 'rose' | 'violet' | 'cyan'

@Component({
  selector: 'app-v2-pill',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="pill" [class]="'pill--' + color" [style.font-size.px]="size"><ng-content /></span>`,
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
        padding: var(--si-space-2) var(--si-space-4);
        border-radius: var(--si-r4);
        border: 1px solid transparent;
        font-family: var(--si-sans);
        font-weight: 500;
        white-space: nowrap;
        letter-spacing: -0.05px;
      }
      .pill--gray {
        background: var(--si-neutral-soft);
        color: var(--si-fg-muted);
        border-color: var(--si-line);
      }
      // Every variant now resolves through tokens. The previous revision wrote
      // literal oklch() for the text and border of five of them — at hues that
      // did not match the tokens they sat on (amber text at hue 75 over an
      // accent fill at hue 55, cyan text at 210 over a fill at 240) — so the
      // pills drifted out of the palette and two of them failed AA.
      .pill--green {
        background: var(--si-green-soft);
        color: var(--si-green-ink);
        border-color: var(--si-green-soft);
      }
      .pill--amber {
        background: var(--si-amber-soft);
        color: var(--si-accent-ink);
        border-color: var(--si-accent-line);
      }
      .pill--rose {
        background: var(--si-rose-soft);
        color: var(--si-rose-ink);
        border-color: var(--si-rose-soft);
      }
      .pill--violet {
        background: var(--si-violet-soft);
        color: var(--si-violet-ink);
        border-color: var(--si-violet-soft);
      }
      .pill--cyan {
        background: var(--si-cyan-soft);
        color: var(--si-cyan-ink);
        border-color: var(--si-cyan-soft);
      }
    `
  ]
})
export class PillComponent {
  @Input() color: PillColor = 'violet'
  @Input() size = 11
}
