import { ChangeDetectionStrategy, Component, EventEmitter, HostListener, Input, Output, inject } from '@angular/core'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { IconV2Component, IconV2Name } from '../icons/icon-v2.component'

export interface ActionSheetItem {
  id: string
  label: string
  icon: IconV2Name
  // 'danger' tints the row rose; otherwise it's the regular fg color.
  kind?: 'default' | 'danger'
  disabled?: boolean
}

export interface ActionSheetDivider {
  id: string
  kind: 'divider'
}

export type ActionSheetEntry = ActionSheetItem | ActionSheetDivider

function isDivider(e: ActionSheetEntry): e is ActionSheetDivider {
  return (e as ActionSheetDivider).kind === 'divider'
}

// Mobile-first bottom-anchored action sheet. Opens from below with a
// list of primary actions, dismisses on backdrop tap or Escape. Used
// behind the Personal FAB to avoid binding the FAB to a single primary
// action when there are several equally common (New folder / New text
// file / Upload / Download from URL).
//
// Usage:
//   <app-v2-action-sheet
//     [open]="sheetOpen()"
//     [title]="'Create' | translate"
//     [items]="[{id:'new-folder', label:'New folder', icon:'plus'}, ...]"
//     (selected)="onSheetSelect($event)"
//     (closed)="sheetOpen.set(false)"
//   />
//
// Emits selected with the item id; the parent dispatches the action.
// Sheet auto-closes on selection.
@Component({
  selector: 'app-v2-action-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconV2Component, L10nTranslatePipe],
  template: `
    @if (open) {
      <div class="as__backdrop" (click)="onBackdrop()" aria-hidden="true"></div>
      <div class="as" role="dialog" [attr.aria-label]="title | translate: locale.language">
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
                  <app-v2-icon [name]="it.icon" [size]="18" class="as__icon" />
                  <span class="as__label">{{ it.label | translate: locale.language }}</span>
                </button>
              </li>
            }
          }
        </ul>
        <button type="button" class="as__cancel" (click)="onBackdrop()">
          {{ 'Cancel' | translate: locale.language }}
        </button>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }
      .as__backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        z-index: var(--si-z-popover);
        animation: as-fade-in 140ms ease-out;
      }
      .as {
        position: fixed;
        left: 12px;
        right: 12px;
        bottom: calc(12px + env(safe-area-inset-bottom, 0px));
        z-index: calc(var(--si-z-popover) + 1);
        background: var(--si-bg1);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r3);
        box-shadow: var(--si-shadow3);
        padding: 8px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        animation: as-slide-up 200ms cubic-bezier(0.2, 0.7, 0.2, 1);
      }
      .as__title {
        font-family: var(--si-display);
        font-size: var(--si-text-6);
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--si-fg-faint);
        padding: 8px 12px 4px;
      }
      .as__list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .as__item {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 12px;
        height: 48px;
        padding: 0 14px;
        background: transparent;
        border: 0;
        border-radius: 8px;
        font: inherit;
        font-size: var(--si-text-10);
        text-align: left;
        color: var(--si-fg);
        cursor: pointer;
        transition: background 120ms ease;
      }
      .as__item:hover:not(:disabled) {
        background: var(--si-bg3);
      }
      .as__item:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .as__item--danger {
        color: var(--si-rose);
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
      .as__cancel {
        margin-top: 4px;
        height: 44px;
        background: var(--si-bg2);
        border: 0;
        border-radius: 8px;
        font: inherit;
        font-size: var(--si-text-10);
        font-weight: 500;
        color: var(--si-fg-muted);
        cursor: pointer;
        transition:
          background 120ms ease,
          color 120ms ease;
      }
      .as__cancel:hover {
        background: var(--si-bg3);
        color: var(--si-fg);
      }
      .as__divider {
        height: 1px;
        margin: 6px 12px;
        background: var(--si-line);
      }
      @keyframes as-fade-in {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
      @keyframes as-slide-up {
        from {
          transform: translateY(20%);
          opacity: 0;
        }
        to {
          transform: translateY(0);
          opacity: 1;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .as,
        .as__backdrop {
          animation: none;
        }
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
