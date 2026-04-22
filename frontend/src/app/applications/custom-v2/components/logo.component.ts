import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core'

@Component({
  selector: 'app-v2-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="logo" [style.width.px]="size()" [style.height.px]="size()" [style.border-radius.px]="size() * 0.5">
      <div class="ring" [style.inset.px]="innerInset()"></div>
      <div class="dot" [style.width.px]="dotSize()" [style.height.px]="dotSize()" [style.box-shadow]="dotGlow()"></div>
    </div>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        flex-shrink: 0;
      }
      .logo {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        background: conic-gradient(from 210deg, oklch(0.78 0.17 55), oklch(0.55 0.18 25), oklch(0.38 0.12 275), oklch(0.78 0.17 55));
        box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.35);
      }
      .ring {
        position: absolute;
        border-radius: 50%;
        background: var(--si-chrome-bg);
        box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.08);
      }
      .dot {
        position: absolute;
        border-radius: 50%;
        background: oklch(0.82 0.17 55);
      }
    `
  ]
})
export class LogoComponent {
  readonly size = input<number>(22)

  readonly innerInset = computed(() => Math.round(this.size() * 0.18))
  readonly dotSize = computed(() => Math.round(this.size() * 0.28))
  readonly dotGlow = computed(() => `0 0 ${Math.round(this.size() * 0.4)}px oklch(0.82 0.17 55 / 0.6)`)
}
