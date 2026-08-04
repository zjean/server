import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core'
import { IconV2Component, IconV2Name } from '../icons/icon-v2.component'

export interface SegmentedOption<T extends string = string> {
  id: T
  /** Omit for an icon-only segment; then `icon` and `title` are both required. */
  label?: string
  icon?: IconV2Name
  /** Tooltip / accessible name. Required when there is no label. */
  title?: string
}

// A segmented control: two to four mutually exclusive choices, always visible.
//
// The design reaches for this in four places and it was hand-rolled in every one
// (view mode, density, search scope, edit/preview), which is why the four looked
// subtly different from each other. Its rule for choosing it over a select: use a
// segment when the options are few and worth showing, and a select when they are
// many or the current value is the only interesting one.
//
// The active segment is a surface step UP (bg6) rather than an accent fill —
// deliberately. An accent fill here would read as "the thing you act on", and a
// segmented control is a statement about what you are already looking at. The one
// exception the design draws is the search-scope segment inside the search field,
// where the active pill IS accent-tinted; pass `emphasis="accent"` for that.
@Component({
  selector: 'app-v2-segmented',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconV2Component],
  template: `
    <div class="seg" [class]="'seg--' + size() + ' seg--' + emphasis()" role="radiogroup" [attr.aria-label]="ariaLabel()">
      @for (o of options(); track o.id) {
        <button
          type="button"
          class="seg__btn"
          [class.seg__btn--active]="o.id === value()"
          role="radio"
          [attr.aria-checked]="o.id === value()"
          [attr.title]="o.title ?? o.label ?? null"
          [attr.aria-label]="o.label ? null : (o.title ?? null)"
          (click)="pick(o.id)"
        >
          @if (o.icon) {
            <app-v2-icon [name]="o.icon" [size]="iconPx()" />
          }
          @if (o.label) {
            <span>{{ o.label }}</span>
          }
        </button>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
      }
      /* The track is a surface step below the active segment, so the active one
         reads as raised without a border or a shadow. */
      .seg {
        display: inline-flex;
        align-items: center;
        gap: var(--si-space-1);
        padding: var(--si-space-1);
        background: var(--si-bg3);
        border-radius: var(--si-r1);
      }
      .seg__btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: var(--si-space-3);
        border: 0;
        background: transparent;
        color: var(--si-fg-tertiary);
        font-family: var(--si-sans);
        font-weight: 400;
        border-radius: var(--si-r0);
        cursor: pointer;
        white-space: nowrap;
        transition:
          background var(--si-dur-2) var(--si-ease-out),
          color var(--si-dur-2) var(--si-ease-out);
      }
      .seg__btn:hover:not(.seg__btn--active) {
        color: var(--si-fg);
      }
      .seg--neutral .seg__btn--active {
        background: var(--si-bg6);
        color: var(--si-fg);
        font-weight: 500;
      }
      .seg--accent .seg__btn--active {
        background: var(--si-accent-soft);
        color: var(--si-accent-ink);
        font-weight: 500;
      }

      .seg--sm .seg__btn {
        height: 26px;
        padding: 0 var(--si-space-5);
        font-size: var(--si-text-6);
      }
      .seg--md .seg__btn {
        height: 28px;
        padding: 0 var(--si-space-5);
        font-size: var(--si-text-7);
      }
      /* Icon-only segments are square at every size rather than padded, so a
         three-way view switcher reads as one cluster instead of three words. */
      .seg__btn:not(:has(span)) {
        padding: 0;
        aspect-ratio: 1;
      }
    `
  ]
})
export class SegmentedComponent<T extends string = string> {
  readonly options = input.required<readonly SegmentedOption<T>[]>()
  readonly value = input.required<T>()
  readonly size = input<'sm' | 'md'>('md')
  readonly emphasis = input<'neutral' | 'accent'>('neutral')
  readonly ariaLabel = input<string | null>(null)

  readonly changed = output<T>()

  protected readonly iconPx = computed(() => (this.size() === 'sm' ? 14 : 15))

  protected pick(id: T): void {
    if (id !== this.value()) this.changed.emit(id)
  }
}
