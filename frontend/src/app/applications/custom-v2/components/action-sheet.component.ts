import { ChangeDetectionStrategy, Component, EventEmitter, HostListener, Input, Output, inject } from '@angular/core'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { IconV2Component, IconV2Name } from '../icons/icon-v2.component'
import { SheetDragDirective } from './sheet-drag.directive'

export interface ActionSheetItem {
  id: string
  label: string
  /** Optional so a `ContextMenuItem` can be handed straight to this component. */
  icon?: IconV2Name
  /** `danger` tints the row `--si-rose-ink`; otherwise it is the regular fg colour. */
  kind?: 'default' | 'danger'
  disabled?: boolean
  /** Trailing machine output — the design's "Version history · 3". */
  meta?: string | number | null
}

export interface ActionSheetDivider {
  id: string
  kind: 'divider'
}

export type ActionSheetEntry = ActionSheetItem | ActionSheetDivider

function isDivider(e: ActionSheetEntry): e is ActionSheetDivider {
  return (e as ActionSheetDivider).kind === 'divider'
}

/**
 * The bottom action sheet (`M6`).
 *
 * What a menu becomes on a touch layout: the design moves "the ⋯ menu" into a sheet along
 * with five other surfaces, and the reason is reachability rather than fashion — a menu
 * anchored to the tap point puts its items wherever the finger happened to be, including
 * against the top edge, while a sheet always opens under the thumb.
 *
 * It shares `_sheet.scss` and the drag directive with the inspector sheet, so the handle,
 * the radius, the scrim and drag-to-dismiss are the same control in both places. It is
 * auto-height rather than snapping: a list of seven actions has one correct height, and
 * the two snap points exist for a panel whose content scrolls.
 *
 * ```html
 * <app-v2-action-sheet [open]="menu() !== null" [items]="menuItems()" (selected)="pick($event)" (closed)="closeMenu()">
 *   <div actionSheetHead class="v2-sheet__head">…</div>
 * </app-v2-action-sheet>
 * ```
 *
 * A projected header rather than a `file` input: the sheet is used for a file's actions
 * AND for the FAB's create menu, and only the caller knows which identity — if any —
 * belongs at the top. `title` remains for the second case.
 *
 * Two of the design's own affordances are deliberately absent:
 *
 *  • **No Cancel button.** The design's sheets have none: they are dismissed by drag or
 *    scrim tap, and a full-width Cancel at the bottom is the pattern its `actions` slot is
 *    reserved for. Escape still closes it, for the desktop cases that reach it.
 *  • **No snap points.** See above — auto height.
 */
@Component({
  selector: 'app-v2-action-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconV2Component, SheetDragDirective, L10nTranslatePipe],
  template: `
    @if (open) {
      <div class="v2-sheet-scrim" (click)="onBackdrop()" aria-hidden="true"></div>
      <div
        class="v2-sheet v2-sheet--auto"
        role="dialog"
        [attr.aria-label]="title || 'Actions' | translate: locale.language"
        appV2SheetDrag
        dragMode="dismiss"
        (dismissed)="onBackdrop()"
      >
        <!-- Affordance only: this sheet's handle has nothing to toggle (no second
             height), so it is not a button and not announced. Drag it or tap the scrim. -->
        <div class="v2-sheet__handle" aria-hidden="true"></div>
        <ng-content select="[actionSheetHead]" />
        @if (title) {
          <div class="as__title">{{ title | translate: locale.language }}</div>
        }
        <ul class="as__list" role="menu">
          @for (it of items; track it.id) {
            @if (isDivider(it)) {
              <li><div class="as__divider" role="separator" aria-orientation="horizontal"></div></li>
            } @else {
              <li>
                <button type="button" class="as__item" [class.as__item--danger]="it.kind === 'danger'" [disabled]="it.disabled" (click)="onPick(it)">
                  @if (it.icon) {
                    <app-v2-icon [name]="it.icon" [size]="19" class="as__icon" />
                  }
                  <span class="as__label">{{ it.label | translate: locale.language }}</span>
                  @if (it.meta !== null && it.meta !== undefined && it.meta !== '') {
                    <span class="as__meta">{{ it.meta }}</span>
                  }
                </button>
              </li>
            }
          }
        </ul>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }
      .as__title {
        font-family: var(--si-display);
        font-size: var(--si-text-6);
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--si-fg-muted);
        padding: var(--si-space-4) var(--si-space-8) var(--si-space-2);
      }
      .as__list {
        list-style: none;
        margin: 0;
        /* The bottom inset keeps the last action clear of the home indicator. */
        padding: var(--si-space-4) var(--si-space-4) calc(var(--si-space-6) + env(safe-area-inset-bottom, 0px));
        display: flex;
        flex-direction: column;
        gap: var(--si-space-1);
        /* Seven actions fit; a longer list scrolls rather than growing past the sheet. */
        overflow-y: auto;
        overscroll-behavior: contain;
      }
      .as__item {
        width: 100%;
        display: flex;
        align-items: center;
        gap: var(--si-space-7);
        /* 52px on a touch layout, from _touch.scss — the design's figure for a sheet
           action, "the last thing you touch before something happens". */
        min-height: 48px;
        padding: 0 var(--si-space-7);
        background: transparent;
        border: 0;
        border-radius: var(--si-r2);
        font: inherit;
        font-size: var(--si-text-10);
        text-align: left;
        color: var(--si-fg);
        cursor: pointer;
        transition: background var(--si-dur-2) var(--si-ease-out);
      }
      .as__item:hover:not(:disabled) {
        background: var(--si-bg6);
      }
      .as__item:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      /* The -ink tone, not the fill: this is type on a surface. */
      .as__item--danger {
        color: var(--si-rose-ink);
      }
      .as__item--danger:hover:not(:disabled) {
        background: var(--si-rose-soft);
      }
      .as__icon {
        flex-shrink: 0;
        opacity: 0.85;
      }
      .as__label {
        flex: 1 1 auto;
      }
      .as__meta {
        flex: none;
        font-family: var(--si-mono);
        font-size: var(--si-text-3);
        color: var(--si-fg-tertiary);
      }
      .as__divider {
        height: 1px;
        margin: var(--si-space-3) var(--si-space-7);
        background: var(--si-line);
      }
    `
  ]
})
export class ActionSheetComponent {
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  protected readonly isDivider = isDivider
  @Input() open = false
  @Input() title = ''
  @Input() items: readonly ActionSheetEntry[] = []
  @Output() readonly selected = new EventEmitter<string>()
  @Output() readonly closed = new EventEmitter<void>()

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open) this.closed.emit()
  }

  protected onBackdrop(): void {
    this.closed.emit()
  }

  protected onPick(item: ActionSheetItem): void {
    if (item.disabled) return
    this.selected.emit(item.id)
    this.closed.emit()
  }
}
