import { ChangeDetectionStrategy, Component, ElementRef, EventEmitter, HostListener, inject, Input, Output } from '@angular/core'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { IconV2Component, IconV2Name } from '../icons/icon-v2.component'

export interface ContextMenuItem {
  id: string
  label: string
  icon?: IconV2Name
  kind?: 'default' | 'danger'
  disabled?: boolean
  disabledReason?: string
  action: () => void
}

export interface ContextMenuDivider {
  id: string
  kind: 'divider'
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuDivider

function isDivider(e: ContextMenuEntry): e is ContextMenuDivider {
  return (e as ContextMenuDivider).kind === 'divider'
}

export interface ContextMenuAnchor {
  x: number
  y: number
}

const MENU_WIDTH = 200
const MENU_ITEM_HEIGHT = 34
const MENU_PADDING = 8
const VIEWPORT_GUTTER = 8

@Component({
  selector: 'app-v2-context-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconV2Component, L10nTranslatePipe],
  template: `
    @if (open && anchor) {
      <div
        class="ctx-menu"
        role="menu"
        [style.left.px]="position.x"
        [style.top.px]="position.y"
        (click)="$event.stopPropagation()"
        (contextmenu)="$event.preventDefault(); $event.stopPropagation()"
      >
        @for (item of items; track item.id) {
          @if (isDivider(item)) {
            <div class="ctx-menu__divider" role="separator" aria-orientation="horizontal"></div>
          } @else {
            <button
              type="button"
              role="menuitem"
              class="ctx-menu__item"
              [class.ctx-menu__item--danger]="item.kind === 'danger'"
              [disabled]="item.disabled"
              [attr.title]="item.disabled && item.disabledReason ? (item.disabledReason | translate: locale.language) : null"
              (click)="onItemClick($event, item)"
            >
              @if (item.icon) {
                <app-v2-icon [name]="item.icon" [size]="14" />
              } @else {
                <span class="ctx-menu__icon-spacer"></span>
              }
              <span class="ctx-menu__label">{{ item.label | translate: locale.language }}</span>
            </button>
          }
        }
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }
      .ctx-menu {
        position: fixed;
        z-index: var(--si-z-popover);
        min-width: ${MENU_WIDTH}px;
        padding: var(--si-space-2);
        /* bg5 is the overlay surface _tokens.scss names for "dialogs, context
           menus, sheets, popovers". This was bg1 — below the content plane it
           opens over — which is the same divergence the six dialogs had. */
        background: var(--si-bg5);
        /* The third text tier does not exist on bg5 (4.06 against a 4.5 floor), so
           it is re-pointed for the subtree — see _dialog.scss for the reasoning. No
           item uses it today; the declaration is here so the next one cannot ship
           at 4.06 by inheriting a tone that is legal on the plane this opens over. */
        --si-fg-tertiary: var(--si-fg-muted);
        border: 1px solid var(--si-border);
        border-radius: var(--si-r2);
        box-shadow: var(--si-shadow2);
        display: flex;
        flex-direction: column;
        gap: 1px;
        pointer-events: auto;
      }
      .ctx-menu__item {
        display: inline-flex;
        align-items: center;
        gap: var(--si-space-5);
        height: ${MENU_ITEM_HEIGHT}px;
        padding: 0 var(--si-space-5);
        background: transparent;
        border: none;
        border-radius: var(--si-r1);
        color: var(--si-fg);
        font: inherit;
        font-size: var(--si-text-11);
        text-align: left;
        cursor: pointer;
        transition:
          background 100ms ease,
          color 100ms ease;
      }
      /* bg6, not bg3. Hover has to step UP from the menu's own surface, and bg3 is
         darker than bg5 — on the old bg1 menu it read as a lift, here it would be a
         dent. bg6 is the token for "pressed, drag-over, segmented-on". */
      .ctx-menu__item:hover:not(:disabled) {
        background: var(--si-bg6);
      }
      .ctx-menu__item:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .ctx-menu__item--danger {
        color: var(--si-rose-ink);
      }
      .ctx-menu__item--danger:hover:not(:disabled) {
        background: var(--si-rose-soft);
      }
      .ctx-menu__icon-spacer {
        display: inline-block;
        width: 14px;
        height: 14px;
      }
      .ctx-menu__label {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ctx-menu__divider {
        height: 1px;
        margin: var(--si-space-2) var(--si-space-3);
        background: var(--si-line);
      }
    `
  ]
})
export class ContextMenuComponent {
  private readonly host = inject(ElementRef<HTMLElement>)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  protected readonly isDivider = isDivider

  @Input() items: ContextMenuEntry[] = []
  @Input() open = false
  @Input() anchor: ContextMenuAnchor | null = null

  @Output() readonly closed = new EventEmitter<void>()

  protected get position(): { x: number; y: number } {
    const a = this.anchor
    if (!a) return { x: 0, y: 0 }
    if (typeof window === 'undefined') return { x: a.x, y: a.y }
    const vw = window.innerWidth
    const vh = window.innerHeight
    const itemCount = this.items.filter((i) => !isDivider(i)).length
    const dividerCount = this.items.length - itemCount
    const menuHeight = Math.max(itemCount, 1) * MENU_ITEM_HEIGHT + dividerCount * 9 + MENU_PADDING
    let x = a.x
    let y = a.y
    if (x + MENU_WIDTH + VIEWPORT_GUTTER > vw) x = Math.max(VIEWPORT_GUTTER, vw - MENU_WIDTH - VIEWPORT_GUTTER)
    if (y + menuHeight + VIEWPORT_GUTTER > vh) y = Math.max(VIEWPORT_GUTTER, vh - menuHeight - VIEWPORT_GUTTER)
    return { x, y }
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(ev: MouseEvent): void {
    if (!this.open) return
    if (!this.host.nativeElement.contains(ev.target as Node)) {
      this.closed.emit()
    }
  }

  @HostListener('document:contextmenu', ['$event'])
  onDocumentContextMenu(ev: MouseEvent): void {
    if (!this.open) return
    if (!this.host.nativeElement.contains(ev.target as Node)) {
      this.closed.emit()
    }
  }

  @HostListener('window:keydown.escape')
  onEscape(): void {
    if (!this.open) return
    this.closed.emit()
  }

  @HostListener('window:resize')
  onResize(): void {
    if (!this.open) return
    this.closed.emit()
  }

  @HostListener('window:scroll', ['$event'])
  onScroll(ev: Event): void {
    if (!this.open) return
    if ((ev.target as Node)?.nodeType && this.host.nativeElement.contains(ev.target as Node)) return
    this.closed.emit()
  }

  protected onItemClick(event: MouseEvent, item: ContextMenuItem): void {
    event.stopPropagation()
    if (item.disabled) return
    item.action()
    this.closed.emit()
  }
}
