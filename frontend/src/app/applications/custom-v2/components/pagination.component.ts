import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core'
import { IconV2Component } from '../icons/icon-v2.component'

const GAP = '…'

// Pagination: a mono range readout on the left, page cluster on the right.
//
// The readout is `1–50 of 214` in mono because every part of it is a number the
// system produced. It is on the left because it answers "where am I", which the
// user reads before deciding to move.
//
// The page window is first · … · current−1 · current · current+1 · … · last, with
// the gaps collapsing rather than the numbers, so the control never changes width
// as you page through — a cluster that reflows under the pointer makes you miss.
@Component({
  selector: 'app-v2-pagination',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconV2Component],
  template: `
    <div class="pg">
      <span class="pg__range">{{ rangeLabel() }}</span>
      <nav class="pg__pages" [attr.aria-label]="ariaLabel()">
        <button type="button" class="pg__step" [disabled]="page() <= 1" [attr.aria-label]="previousLabel()" (click)="go(page() - 1)">
          <app-v2-icon name="chevLeft" [size]="15" />
        </button>
        @for (p of window(); track $index) {
          @if (p === GAP) {
            <span class="pg__gap" aria-hidden="true">{{ GAP }}</span>
          } @else {
            <button
              type="button"
              class="pg__page"
              [class.pg__page--active]="p === page()"
              [attr.aria-current]="p === page() ? 'page' : null"
              (click)="go(+p)"
            >
              {{ p }}
            </button>
          }
        }
        <button type="button" class="pg__step" [disabled]="page() >= pageCount()" [attr.aria-label]="nextLabel()" (click)="go(page() + 1)">
          <app-v2-icon name="chevRight" [size]="15" />
        </button>
      </nav>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .pg {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--si-space-6);
      }
      /* muted, not tertiary: this is a primitive, so it cannot know its surface, and
         its only mount today is a bg3 card in the kit — where tertiary is 4.37. A
         primitive gets the tone that is legal on the deepest surface it can land on. */
      .pg__range {
        font-family: var(--si-mono);
        font-size: var(--si-text-5);
        color: var(--si-fg-muted);
      }
      .pg__pages {
        display: flex;
        align-items: center;
        gap: var(--si-space-2);
      }
      .pg__step,
      .pg__page {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 30px;
        height: 30px;
        border: 0;
        border-radius: var(--si-r1);
        background: transparent;
        color: var(--si-fg-muted);
        font-family: var(--si-mono);
        font-size: var(--si-text-6);
        cursor: pointer;
        transition:
          background var(--si-dur-2) var(--si-ease-out),
          color var(--si-dur-2) var(--si-ease-out);
      }
      .pg__step {
        background: var(--si-bg3);
      }
      .pg__step:hover:not(:disabled),
      .pg__page:hover:not(.pg__page--active) {
        background: var(--si-bg5);
        color: var(--si-fg);
      }
      .pg__step:disabled {
        color: var(--si-fg-ghost);
        cursor: not-allowed;
      }
      .pg__page--active {
        background: var(--si-accent-soft);
        color: var(--si-accent-ink);
        font-weight: 500;
      }
      .pg__gap {
        min-width: 30px;
        text-align: center;
        font-family: var(--si-mono);
        font-size: var(--si-text-6);
        color: var(--si-fg-ghost);
      }
    `
  ]
})
export class PaginationComponent {
  readonly total = input.required<number>()
  readonly perPage = input<number>(50)
  readonly page = input<number>(1)
  readonly ariaLabel = input<string>('Pagination')
  readonly previousLabel = input<string>('Previous page')
  readonly nextLabel = input<string>('Next page')
  /** `{from}–{to} of {total}` — pass a translated pattern to localise it. */
  readonly rangePattern = input<string>('{from}–{to} of {total}')

  readonly changed = output<number>()

  protected readonly GAP = GAP

  protected readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / this.perPage())))

  protected readonly rangeLabel = computed(() => {
    const from = this.total() === 0 ? 0 : (this.page() - 1) * this.perPage() + 1
    const to = Math.min(this.page() * this.perPage(), this.total())
    return this.rangePattern().replace('{from}', String(from)).replace('{to}', String(to)).replace('{total}', String(this.total()))
  })

  protected readonly window = computed<(number | typeof GAP)[]>(() => {
    const last = this.pageCount()
    const cur = Math.min(Math.max(this.page(), 1), last)
    if (last <= 7) return Array.from({ length: last }, (_, i) => i + 1)

    const out: (number | typeof GAP)[] = [1]
    const from = Math.max(2, cur - 1)
    const to = Math.min(last - 1, cur + 1)
    if (from > 2) out.push(GAP)
    for (let p = from; p <= to; p++) out.push(p)
    if (to < last - 1) out.push(GAP)
    out.push(last)
    return out
  })

  protected go(p: number): void {
    const clamped = Math.min(Math.max(p, 1), this.pageCount())
    if (clamped !== this.page()) this.changed.emit(clamped)
  }
}
