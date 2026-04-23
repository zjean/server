import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  EventEmitter,
  HostListener,
  inject,
  Input,
  Output
} from '@angular/core'
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
        [style.left.px]="position().x"
        [style.top.px]="position().y"
        (click)="$event.stopPropagation()"
        (contextmenu)="$event.preventDefault(); $event.stopPropagation()"
      >
        @for (item of items; track item.id) {
          <button
            type="button"
            role="menuitem"
            class="ctx-menu__item"
            [class.ctx-menu__item--danger]="item.kind === 'danger'"
            [disabled]="item.disabled"
            [attr.title]="item.disabled && item.disabledReason ? (item.disabledReason | translate: locale.language) : null"
            (click)="onItemClick(item)"
          >
            @if (item.icon) {
              <app-v2-icon [name]="item.icon" [size]="14" />
            } @else {
              <span class="ctx-menu__icon-spacer"></span>
            }
            <span class="ctx-menu__label">{{ item.label | translate: locale.language }}</span>
          </button>
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
        min-width: ${MENU_WIDTH}px;
        padding: 4px;
        background: var(--si-bg1);
        border: 1px solid var(--si-border);
        border-radius: 8px;
        box-shadow:
          0 4px 10px rgba(0, 0, 0, 0.08),
          0 12px 28px rgba(0, 0, 0, 0.12);
        display: flex;
        flex-direction: column;
        gap: 1px;
        pointer-events: auto;
      }
      .ctx-menu__item {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        height: ${MENU_ITEM_HEIGHT}px;
        padding: 0 10px;
        background: transparent;
        border: none;
        border-radius: 6px;
        color: var(--si-fg);
        font: inherit;
        font-size: 13px;
        text-align: left;
        cursor: pointer;
        transition:
          background 100ms ease,
          color 100ms ease;
      }
      .ctx-menu__item:hover:not(:disabled) {
        background: var(--si-bg3);
      }
      .ctx-menu__item:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .ctx-menu__item--danger {
        color: var(--si-danger, #c0392b);
      }
      .ctx-menu__item--danger:hover:not(:disabled) {
        background: rgba(192, 57, 43, 0.08);
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
    `
  ]
})
export class ContextMenuComponent {
  private readonly host = inject(ElementRef<HTMLElement>)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  @Input() items: ContextMenuItem[] = []
  @Input() open = false
  @Input() anchor: ContextMenuAnchor | null = null

  @Output() readonly closed = new EventEmitter<void>()

  protected readonly position = computed(() => {
    const a = this.anchor
    if (!a) return { x: 0, y: 0 }
    if (typeof window === 'undefined') return { x: a.x, y: a.y }
    const vw = window.innerWidth
    const vh = window.innerHeight
    const menuHeight = Math.max(this.items.length, 1) * MENU_ITEM_HEIGHT + MENU_PADDING
    let x = a.x
    let y = a.y
    if (x + MENU_WIDTH + VIEWPORT_GUTTER > vw) x = Math.max(VIEWPORT_GUTTER, vw - MENU_WIDTH - VIEWPORT_GUTTER)
    if (y + menuHeight + VIEWPORT_GUTTER > vh) y = Math.max(VIEWPORT_GUTTER, vh - menuHeight - VIEWPORT_GUTTER)
    return { x, y }
  })

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

  protected onItemClick(item: ContextMenuItem): void {
    if (item.disabled) return
    item.action()
    this.closed.emit()
  }
}
