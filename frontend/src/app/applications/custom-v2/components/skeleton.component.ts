import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core'

// Loading placeholders that mirror the exact row geometry they replace.
//
// The design's rule is blunt: "Skeletons mirror the exact row geometry.
// 2–5 rows max, never a spinner for a list." Both halves matter. A spinner tells
// the user something is happening but not what is coming, so the layout jumps
// when it arrives; and a screen full of shimmering rows is worse than a quiet
// one, because the shimmer is motion the user cannot act on.
//
// `rows` is clamped to 5 rather than trusted, so a caller that passes
// `files.length` — the obvious mistake, since you rarely know the count yet —
// cannot paint fifty shimmering bars.
@Component({
  selector: 'app-v2-skeleton',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sk" role="status" [attr.aria-label]="ariaLabel()">
      @for (r of rowRange(); track r) {
        <div class="sk__row" [style.height.px]="rowHeight()">
          @if (glyph()) {
            <span class="sk__glyph sk__shimmer"></span>
          }
          <span class="sk__line sk__shimmer" [style.width.%]="lineWidth(r)"></span>
          <span class="sk__spacer"></span>
          @if (trailing()) {
            <span class="sk__meta"></span>
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .sk__row {
        display: flex;
        align-items: center;
        gap: var(--si-space-6);
        padding: 0 var(--si-space-6);
      }
      .sk__glyph {
        width: 26px;
        height: 26px;
        border-radius: var(--si-r1);
        flex: none;
      }
      .sk__line {
        height: 9px;
        border-radius: var(--si-r0);
      }
      .sk__spacer {
        flex: 1;
      }
      /* The trailing block does not shimmer. Two moving things per row read as
         noise; one reads as progress. */
      .sk__meta {
        width: 52px;
        height: 9px;
        border-radius: var(--si-r0);
        background: var(--si-bg3);
        flex: none;
      }
      .sk__shimmer {
        background: linear-gradient(90deg, var(--si-bg3) 0%, var(--si-bg5) 50%, var(--si-bg3) 100%);
        background-size: 340px 100%;
        animation: sk-shimmer 1.4s linear infinite;
      }
      @keyframes sk-shimmer {
        0% {
          background-position: -340px 0;
        }
        100% {
          background-position: 340px 0;
        }
      }
      /* The global reduced-motion rule in v2.scss collapses the duration, which
         would leave the gradient frozen mid-sweep at a random offset. Drop to a
         flat fill instead. */
      @media (prefers-reduced-motion: reduce) {
        .sk__shimmer {
          background: var(--si-bg3);
          animation: none;
        }
      }
    `
  ]
})
export class SkeletonComponent {
  readonly rows = input<number>(3)
  readonly rowHeight = input<number>(44)
  readonly glyph = input<boolean>(true)
  readonly trailing = input<boolean>(true)
  readonly ariaLabel = input<string>('Loading')

  protected readonly rowRange = computed(() => Array.from({ length: Math.min(Math.max(this.rows(), 1), 5) }, (_, i) => i))

  // Varied widths so the block reads as a list of different names rather than a
  // bar chart. Deterministic, not random: an SSR pass and the client hydration
  // must agree, and a re-render must not reshuffle.
  protected lineWidth(i: number): number {
    return [62, 44, 54, 38, 58][i % 5]
  }
}
