import { ChangeDetectionStrategy, Component, computed, ElementRef, inject, input, output, signal } from '@angular/core'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { IconV2Component } from '../icons/icon-v2.component'
import { ContextMenuAnchor, ContextMenuComponent, ContextMenuEntry } from './context-menu.component'

export interface SelectOption<T extends string = string> {
  id: T
  /** i18n key or literal — translated here. */
  label: string
  /** Rendered under the label in the menu; for "why this is the wrong choice". */
  hint?: string
  disabled?: boolean
  disabledReason?: string
}

/**
 * A select.
 *
 * Two rules from the design, both of which the native `<select>` this replaces broke:
 *
 *  • **It shows the current VALUE, never a label.** "Can edit", not "Permission:
 *    Can edit". The label belongs to the row the control sits in; repeating it inside
 *    the control costs the width that the value needs.
 *  • **The menu opens on the trigger's edge with a 4px offset and `--si-shadow2`** —
 *    which is `app-v2-context-menu`, so this is a trigger around that rather than a
 *    second popover implementation. A native `<select>` cannot be styled to either
 *    rule; its dropdown is the OS's.
 *
 * Deferred out of phase 1 with the note that phase 5 would be the first screen to
 * need it. It is: D7 has four of them.
 */
@Component({
  selector: 'app-v2-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ContextMenuComponent, IconV2Component, L10nTranslatePipe],
  template: `
    <button
      type="button"
      class="sel"
      [class.sel--sm]="size() === 'sm'"
      [disabled]="disabled()"
      [attr.aria-label]="ariaLabel()"
      [attr.aria-haspopup]="'menu'"
      [attr.aria-expanded]="open()"
      (click)="toggle($event)"
    >
      <span class="sel__value">{{ currentLabel() | translate: locale.language }}</span>
      <app-v2-icon name="chevDown" [size]="13" class="sel__chev" />
    </button>
    <app-v2-context-menu [items]="items()" [open]="open()" [anchor]="anchor()" (closed)="close()" />
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        position: relative;
      }
      .sel {
        display: inline-flex;
        align-items: center;
        gap: var(--si-space-4);
        height: 36px;
        padding: 0 var(--si-space-5);
        border: 0;
        border-radius: var(--si-r1);
        background: var(--si-bg3);
        color: var(--si-fg);
        font-family: var(--si-sans);
        font-size: var(--si-text-8);
        cursor: pointer;
        white-space: nowrap;
        transition: background var(--si-dur-2) var(--si-ease-out);
      }
      .sel--sm {
        height: 30px;
        padding: 0 var(--si-space-4);
        font-size: var(--si-text-7);
      }
      /* Hover is a surface step up; the control never moves. */
      .sel:hover:not(:disabled) {
        background: var(--si-bg5);
      }
      /* tertiary on the bg3 fill is 4.37, below the 4.5 floor — legal here because
         SC 1.4.3 exempts an inactive control, and a disabled select that reads as
         brightly as a live one is the defect. One of the two exemptions listed with
         the tier in _tokens.scss; do not sweep it to muted. */
      .sel:disabled {
        cursor: not-allowed;
        color: var(--si-fg-tertiary);
      }
      .sel:focus-visible {
        outline: 2px solid var(--si-focus-ring);
        outline-offset: 1px;
      }
      /* A glyph, so the floor is SC 1.4.11's 3:1, not 4.5: tertiary measures 4.37 on
         the bg3 fill and 4.06 on the bg5 hover step, and clears it on both. The other
         exemption in _tokens.scss. */
      .sel__chev {
        color: var(--si-fg-tertiary);
        flex: none;
      }
    `
  ]
})
export class SelectComponent<T extends string = string> {
  readonly options = input.required<readonly SelectOption<T>[]>()
  readonly value = input.required<T>()
  readonly size = input<'sm' | 'md'>('md')
  readonly disabled = input<boolean>(false)
  readonly ariaLabel = input<string | null>(null)

  readonly changed = output<T>()

  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private readonly host = inject(ElementRef<HTMLElement>)

  protected readonly open = signal(false)
  protected readonly anchor = signal<ContextMenuAnchor | null>(null)

  // The VALUE, which is all the trigger shows. Falls back to the raw id rather than
  // to blank: an id on screen is a bug you can see.
  protected readonly currentLabel = computed(() => {
    const v = this.value()
    return this.options().find((o) => o.id === v)?.label ?? v
  })

  protected readonly items = computed<ContextMenuEntry[]>(() =>
    this.options().map((o) => ({
      id: o.id,
      label: o.label,
      icon: o.id === this.value() ? ('check' as const) : undefined,
      disabled: o.disabled,
      disabledReason: o.disabledReason,
      action: () => this.changed.emit(o.id)
    }))
  )

  protected toggle(ev: Event): void {
    ev.stopPropagation()
    if (this.open()) {
      this.close()
      return
    }
    // On the trigger's own edge with the design's 4px offset, measured from the host
    // rather than the pointer — a menu opened from a control belongs on the control,
    // and this one is reachable by keyboard.
    const rect = (this.host.nativeElement as HTMLElement).getBoundingClientRect()
    this.anchor.set({ x: rect.left, y: rect.bottom + 4 })
    this.open.set(true)
  }

  protected close(): void {
    this.open.set(false)
    this.anchor.set(null)
  }
}
