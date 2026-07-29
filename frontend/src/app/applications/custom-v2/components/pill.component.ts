import { ChangeDetectionStrategy, Component, Input } from '@angular/core'

export type PillColor = 'gray' | 'indigo' | 'green' | 'amber' | 'rose' | 'violet' | 'cyan' | 'warm'

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
        gap: 5px;
        line-height: 1;
        padding: 4px 8px;
        border-radius: var(--si-r4);
        border: 1px solid transparent;
        font-family: var(--si-sans);
        font-weight: 500;
        white-space: nowrap;
        letter-spacing: -0.05px;
      }
      .pill--gray {
        background: rgba(255, 255, 255, 0.05);
        color: var(--si-fg-muted);
        border-color: var(--si-line);
      }
      .pill--indigo {
        // Legacy "indigo" pill name — under the Stack palette it resolves
        // to the amber accent, since nav and accent have collapsed to one
        // hue. Kept as an alias so existing call sites don't churn.
        background: var(--si-accent-soft);
        color: var(--si-accent);
        border-color: var(--si-accent-line);
      }
      .pill--green {
        background: var(--si-green-soft);
        color: oklch(0.86 0.13 155);
        border-color: oklch(0.76 0.15 155 / 0.3);
      }
      .pill--amber {
        background: var(--si-amber-soft);
        color: oklch(0.9 0.11 75);
        border-color: oklch(0.82 0.14 75 / 0.3);
      }
      .pill--rose {
        background: var(--si-rose-soft);
        color: oklch(0.82 0.15 20);
        border-color: oklch(0.72 0.17 20 / 0.3);
      }
      .pill--violet {
        background: var(--si-violet-soft);
        color: oklch(0.86 0.14 305);
        border-color: oklch(0.75 0.16 305 / 0.3);
      }
      .pill--cyan {
        background: var(--si-cyan-soft);
        color: oklch(0.88 0.1 210);
        border-color: oklch(0.78 0.13 210 / 0.3);
      }
      .pill--warm {
        background: var(--si-accent-soft);
        color: var(--si-accent);
        border-color: var(--si-accent-line);
      }
    `
  ]
})
export class PillComponent {
  @Input() color: PillColor = 'violet'
  @Input() size = 11
}
