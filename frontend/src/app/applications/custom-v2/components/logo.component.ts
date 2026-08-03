import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core'

// The Sync-In mark: a solid cobalt disc with a punched-out centre.
//
// This replaces a kraft→navy conic gradient with a glowing dot. That mark was
// built for the pre-adoption palette and there was no way to re-token it — a
// gradient across three hues has no counterpart in a system whose whole premise
// is one accent — so the geometry changed with the palette (see the design's own
// masthead and `SyncNav`, where the mark is drawn at 22, 24 and 30px).
//
// The centre is --si-bg0 rather than transparent so it reads as a hole cut in the
// disc. That is exact wherever the mark actually sits — the sidebar header and
// the mobile title bar both paint bg0 — and the design hardcodes the same value.
// On any other surface the "hole" would be a dark dot instead; if the mark ever
// needs to live somewhere else, that is the line to revisit.
@Component({
  selector: 'app-v2-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="logo" [style.width.px]="size()" [style.height.px]="size()">
      <div class="dot" [style.width.px]="dotSize()" [style.height.px]="dotSize()"></div>
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
        border-radius: var(--si-r4);
        background: var(--si-accent);
      }
      .dot {
        border-radius: var(--si-r4);
        background: var(--si-bg0);
      }
    `
  ]
})
export class LogoComponent {
  readonly size = input<number>(22)

  // 1/3 of the diameter, which is the ratio the design draws at every size
  // (8px in a 24px mark, 10px in a 30px one).
  readonly dotSize = computed(() => Math.round(this.size() / 3))
}
