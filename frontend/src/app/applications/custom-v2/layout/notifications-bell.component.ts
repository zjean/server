import { HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, ElementRef, HostListener, inject, signal, viewChild } from '@angular/core'
import { Router } from '@angular/router'
import { NOTIFICATION_APP } from '@sync-in-server/backend/src/applications/notifications/constants/notifications'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { TimeAgoPipe } from '../../../common/pipes/time-ago.pipe'
import { SPACES_PATH } from '../../spaces/spaces.constants'
import { StoreService } from '../../../store/store.service'
import { NotificationModel } from '../../notifications/models/notification.model'
import { NotificationsService } from '../../notifications/notifications.service'
import { IconV2Component } from '../icons/icon-v2.component'
import { ToastService } from '../components/toast.service'

/**
 * Notifications bell for the v2 title bar. Reads from the classic
 * StoreService.notifications signal, which is already populated on WebSocket
 * NOTIFICATION events by the classic UserService bootstrap (no second socket
 * connection needed).
 */
@Component({
  selector: 'app-v2-notifications-bell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconV2Component, TimeAgoPipe, L10nTranslateDirective, L10nTranslatePipe],
  template: `
    <div class="nb" #root>
      <button
        type="button"
        class="nb__trigger"
        [attr.title]="'Notifications' | translate: locale.language"
        [class.nb__trigger--open]="open()"
        (click)="toggle($event)"
      >
        <app-v2-icon name="bell" [size]="16" />
        @if (unreadCount() > 0) {
          <span class="nb__badge">{{ unreadCount() > 99 ? '99+' : unreadCount() }}</span>
        }
      </button>

      @if (open()) {
        <div class="nb__panel" role="dialog" aria-modal="false">
          <div class="nb__panel-head">
            <span class="nb__panel-title" l10nTranslate>Notifications</span>
            @if (notifications().length > 0) {
              <button type="button" class="nb__clear" (click)="deleteAll()" [attr.title]="'Clear all' | translate: locale.language">
                {{ 'Clear all' | translate: locale.language }}
              </button>
            }
          </div>

          @if (notifications().length === 0) {
            <div class="nb__empty" l10nTranslate>No notifications.</div>
          } @else {
            <ul class="nb__list">
              @for (n of notifications(); track n.id) {
                <li class="nb-item" [class.nb-item--unread]="!n.wasRead">
                  <button class="nb-item__body" type="button" (click)="goto(n)">
                    <div class="nb-item__head">
                      <span class="nb-item__author">{{ n.fromUser.fullName }}</span>
                      <span class="nb-item__time">{{ n.createdAt | amTimeAgo }}</span>
                    </div>
                    <div class="nb-item__content">
                      <span class="nb-item__event">{{ n.content.event | translate: locale.language }}</span>
                      @if (n.content.element) {
                        : <b class="nb-item__element">{{ n.content.element }}</b>
                      }
                    </div>
                  </button>
                  <button type="button" class="nb-item__remove" (click)="remove(n, $event)" [attr.title]="'Dismiss' | translate: locale.language">
                    ×
                  </button>
                </li>
              }
            </ul>
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
      }
      .nb {
        position: relative;
      }
      .nb__trigger {
        position: relative;
        width: 32px;
        height: 32px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        border-radius: var(--si-r2);
        color: var(--si-fg-muted);
        cursor: pointer;
        padding: 0;
        transition:
          background var(--si-dur-2) var(--si-ease),
          color var(--si-dur-2) var(--si-ease);

        &:hover {
          background: var(--si-bg3);
          color: var(--si-fg);
        }
        &--open {
          background: var(--si-bg5);
          color: var(--si-fg);
        }
      }
      .nb__badge {
        position: absolute;
        top: 2px;
        right: 2px;
        min-width: 15px;
        height: 15px;
        padding: 0 var(--si-space-2);
        border-radius: var(--si-r4);
        background: var(--si-rose);
        // White is safe on THIS fill (4.83:1) but was not on the previous one,
        // where it measured 2.78:1 and was the app's only AA text failure. That
        // is why this used to be hand-written dark ink; the token now carries the
        // decision, and the design uses the same pairing for "Delete forever".
        color: var(--si-rose-fg);
        font-size: var(--si-text-1);
        font-weight: 700;
        font-family: var(--si-mono);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        letter-spacing: -0.2px;
      }
      .nb__panel {
        position: absolute;
        top: calc(100% + 8px);
        right: 0;
        width: 340px;
        max-height: 460px;
        display: flex;
        flex-direction: column;
        background: var(--si-bg2);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r3);
        box-shadow: var(--si-shadow2);
        z-index: var(--si-z-popover);
        overflow: hidden;
      }
      .nb__panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--si-space-5) var(--si-space-6);
        border-bottom: 1px solid var(--si-line);
      }
      .nb__panel-title {
        font-size: var(--si-text-8);
        font-weight: 600;
        color: var(--si-fg);
        letter-spacing: -0.1px;
      }
      .nb__clear {
        font-size: var(--si-text-4);
        background: transparent;
        border: none;
        color: var(--si-fg-muted);
        cursor: pointer;
        padding: var(--si-space-2) var(--si-space-3);
        border-radius: var(--si-r1);

        &:hover {
          color: var(--si-fg);
          background: var(--si-bg3);
        }
      }
      .nb__empty {
        padding: var(--si-space-11) var(--si-space-7);
        text-align: center;
        font-size: var(--si-text-6);
        color: var(--si-fg-muted);
      }
      .nb__list {
        list-style: none;
        margin: 0;
        padding: var(--si-space-2) 0;
        overflow-y: auto;
        min-height: 0;
        flex: 1 1 auto;
      }
      .nb-item {
        position: relative;
        display: flex;
        align-items: stretch;
        border-left: 2px solid transparent;
        transition: background var(--si-dur-2) var(--si-ease);

        &:hover {
          background: var(--si-bg3);
        }
        &--unread {
          border-left-color: var(--si-nav);
          background: var(--si-nav-soft);
        }
        &--unread:hover {
          background: var(--si-nav-soft);
          filter: brightness(1.08);
        }
      }
      .nb-item__body {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: var(--si-space-2);
        padding: var(--si-space-4) var(--si-space-6);
        background: transparent;
        border: none;
        text-align: left;
        cursor: pointer;
        color: inherit;
        font-family: inherit;
      }
      .nb-item__head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: var(--si-space-4);
      }
      .nb-item__author {
        font-size: var(--si-text-6);
        font-weight: 600;
        color: var(--si-fg);
        letter-spacing: -0.1px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .nb-item__time {
        font-size: var(--si-text-3);
        color: var(--si-fg-faint);
        font-family: var(--si-mono);
        flex-shrink: 0;
      }
      .nb-item__content {
        font-size: var(--si-text-5);
        color: var(--si-fg-muted);
        line-height: 1.35;
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .nb-item__element {
        color: var(--si-fg);
        font-weight: 600;
      }
      .nb-item__remove {
        width: 22px;
        align-self: flex-start;
        margin-top: var(--si-space-4);
        margin-right: var(--si-space-3);
        height: 22px;
        border-radius: 5px;
        background: transparent;
        border: none;
        color: var(--si-fg-faint);
        font-size: var(--si-text-11);
        cursor: pointer;
        padding: 0;

        &:hover {
          background: var(--si-bg4);
          color: var(--si-fg);
        }
      }
    `
  ]
})
export class NotificationsBellComponent {
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private readonly store = inject(StoreService)
  private readonly router = inject(Router)
  private readonly toast = inject(ToastService)
  private readonly notificationsService = inject(NotificationsService)

  protected readonly root = viewChild<ElementRef<HTMLDivElement>>('root')

  protected readonly notifications = this.store.notifications
  protected readonly unreadCount = computed(() => this.store.unreadNotifications().length)
  protected readonly open = signal(false)

  protected toggle(ev: MouseEvent): void {
    ev.stopPropagation()
    const willOpen = !this.open()
    this.open.set(willOpen)
    if (willOpen) this.markVisibleAsRead()
  }

  protected goto(n: NotificationModel): void {
    this.open.set(false)
    if (!n.wasRead) this.markOneRead(n)
    if (n.content.externalUrl) {
      window.open(n.content.externalUrl, '_blank', 'noopener')
      return
    }
    if (!n.content?.url) return
    const element = n.content.app === NOTIFICATION_APP.SYNC ? n.content.element.split('/').at(-1) : n.content.element
    this.router.navigate([SPACES_PATH.SPACES, ...n.content.url.split('/')], { queryParams: { select: element } }).catch(console.error)
  }

  protected remove(n: NotificationModel, ev: MouseEvent): void {
    ev.stopPropagation()
    this.notificationsService.deleteNotification(n.id).subscribe({
      next: () => this.store.notifications.update((list) => list.filter((x) => x.id !== n.id)),
      error: (e: HttpErrorResponse) => this.toast.error(e.error?.message ?? 'Unable to dismiss')
    })
  }

  protected deleteAll(): void {
    this.notificationsService.deleteNotification().subscribe({
      next: () => this.store.notifications.set([]),
      error: (e: HttpErrorResponse) => this.toast.error(e.error?.message ?? 'Unable to clear')
    })
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.open()) return
    const root = this.root()?.nativeElement
    if (root && !root.contains(event.target as Node)) {
      this.open.set(false)
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open()) this.open.set(false)
  }

  private markVisibleAsRead(): void {
    // Mark every currently-unread notification as read when the panel opens.
    // Matches the classic intersection-observer behavior pragmatically — the
    // panel is small and fully visible when open, so "visible" == "listed".
    for (const n of this.store.notifications()) {
      if (!n.wasRead) this.markOneRead(n)
    }
  }

  private markOneRead(n: NotificationModel): void {
    if (n.wasRead) return
    n.wasRead = true
    this.notificationsService.wasReadNotification(n.id).subscribe({
      error: () => {
        // Revert on failure so the badge stays accurate.
        n.wasRead = false
      }
    })
    // Nudge the signal so dependent computeds (unreadCount) recompute.
    this.store.notifications.update((list) => [...list])
  }
}
