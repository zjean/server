import { ChangeDetectionStrategy, Component, input, output } from '@angular/core'
import { IconV2Component, IconV2Name } from '../icons/icon-v2.component'

export interface TabItem<T extends string = string> {
  id: T
  label: string
  /** Rendered inline in the label, so the strip needs no second row. */
  count?: number | null
  icon?: IconV2Name
  /** Renders quiet and unclickable, with the reason as a tooltip. */
  disabled?: boolean
  disabledReason?: string
}

// Tabs. **Always labelled — icon-only tabs are forbidden.**
//
// That is the design's rule and it is the whole reason this component exists: the
// inspector shipped five unlabelled glyphs, and the design's evaluation of that
// shape (`2c`) rejected it as "only viable with permanent tooltips". Counts live
// IN the label, which is what lets the strip stay one row high.
//
// Two layouts, because the same control does two jobs:
//   • `fill` — every tab flex:1, evenly divided. For a fixed set inside a narrow
//     panel, where the tabs are the panel's whole navigation. This is the
//     inspector. ICONS ARE SUPPRESSED HERE, and that is not an oversight: four
//     labelled tabs with icons and counts do not fit in 340px — they render as one
//     unbroken run of words — and the design draws this strip label-only for
//     exactly that reason. Callers may pass icons anyway; inline will use them.
//   • `inline` — tabs sized to their content, left-aligned, on a hairline rule.
//     For a page-level strip where the set may grow.
//
// The active tab carries a 2px cobalt underline drawn as an INSET box-shadow
// rather than a border-bottom, so switching tabs never shifts the row by a pixel.
@Component({
  selector: 'app-v2-tabs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconV2Component],
  template: `
    <div class="tabs" [class]="'tabs--' + layout()" role="tablist" [attr.aria-label]="ariaLabel()">
      @for (t of tabs(); track t.id) {
        <button
          type="button"
          class="tabs__tab"
          [class.tabs__tab--active]="t.id === value()"
          [class.tabs__tab--disabled]="t.disabled"
          role="tab"
          [attr.aria-selected]="t.id === value()"
          [disabled]="t.disabled"
          [attr.title]="t.disabled ? (t.disabledReason ?? null) : null"
          (click)="pick(t)"
        >
          @if (t.icon && layout() === 'inline') {
            <app-v2-icon [name]="t.icon" [size]="14" />
          }
          <span class="tabs__label">{{ t.label }}</span>
          @if (t.count !== null && t.count !== undefined) {
            <span class="tabs__count">{{ t.count }}</span>
          }
        </button>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .tabs {
        display: flex;
      }
      .tabs--inline {
        gap: var(--si-space-1);
        border-bottom: 1px solid var(--si-line-subtle);
      }
      .tabs__tab {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: var(--si-space-3);
        border: 0;
        background: transparent;
        color: var(--si-fg-muted);
        font-family: var(--si-sans);
        font-size: var(--si-text-5);
        font-weight: 400;
        padding: var(--si-space-5) var(--si-space-6);
        cursor: pointer;
        white-space: nowrap;
        transition: color var(--si-dur-2) var(--si-ease-out);
      }
      .tabs--fill .tabs__tab {
        flex: 1;
        padding-left: 0;
        padding-right: 0;
      }
      .tabs__tab:hover:not(.tabs__tab--active):not(.tabs__tab--disabled) {
        color: var(--si-fg);
      }
      /* Inset, not border-bottom: a border would add 2px to the active tab only
         and shift the whole strip on every switch. */
      .tabs__tab--active {
        color: var(--si-fg);
        font-weight: 500;
        box-shadow: inset 0 -2px 0 var(--si-accent-hover);
      }
      .tabs__tab--disabled {
        color: var(--si-fg-ghost);
        cursor: not-allowed;
      }
      /* Counts are mono — a count is machine output. */
      .tabs__count {
        font-family: var(--si-mono);
        font-size: var(--si-text-3);
        color: var(--si-fg-tertiary);
      }
      .tabs__tab--active .tabs__count {
        color: var(--si-fg-muted);
      }
    `
  ]
})
export class TabsComponent<T extends string = string> {
  readonly tabs = input.required<readonly TabItem<T>[]>()
  readonly value = input.required<T>()
  readonly layout = input<'fill' | 'inline'>('fill')
  readonly ariaLabel = input<string | null>(null)

  readonly changed = output<T>()

  protected pick(t: TabItem<T>): void {
    if (!t.disabled && t.id !== this.value()) this.changed.emit(t.id)
  }
}
