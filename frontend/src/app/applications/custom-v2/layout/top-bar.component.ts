import { ChangeDetectionStrategy, Component, computed, ElementRef, HostListener, inject, viewChild } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { Router, RouterLink } from '@angular/router'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe, L10nTranslationService } from 'angular-l10n'
import { StoreService } from '../../../store/store.service'
import { AvatarComponent, AvatarUser, avatarHue, avatarInitials } from '../components/avatar.component'
import { IconV2Component } from '../icons/icon-v2.component'
import { V2_PATH, V2_ROUTES } from '../v2.constants'
import { V2BreadcrumbService } from './breadcrumb.service'
import { LayoutV2Service } from './layout-v2.service'
import { NotificationsBellComponent } from './notifications-bell.component'
import { TransfersPopoverComponent } from './transfers-popover.component'

// Desktop top-bar — Stack-style chrome strip above the body. Owns the
// breadcrumb (consumed from V2BreadcrumbService, same source the in-page
// breadcrumb used) and the global ⌘K search field that routes to /v2/search.
// Notifications + transfers move here off the left-nav header so the sidebar
// reads as pure navigation, matching the Stack mockups.
//
// Mobile keeps the existing 40px title-bar — this component is not rendered
// in that layout. The breadcrumb segments are still service-driven so screens
// don't need to know about which chrome is mounted.
@Component({
  selector: 'app-v2-top-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconV2Component, AvatarComponent, NotificationsBellComponent, TransfersPopoverComponent, RouterLink, L10nTranslatePipe],
  template: `
    <header class="topbar">
      <div class="topbar__history">
        <button type="button" class="topbar__chev" [attr.aria-label]="'Back' | translate: locale.language" (click)="goBack()">
          <app-v2-icon name="chevLeft" [size]="14" />
        </button>
        <button type="button" class="topbar__chev" [attr.aria-label]="'Forward' | translate: locale.language" (click)="goForward()">
          <app-v2-icon name="chevRight" [size]="14" />
        </button>
      </div>

      <nav class="topbar__crumbs" [attr.aria-label]="'Breadcrumb' | translate: locale.language">
        @if (segments().length === 0) {
          <span class="topbar__crumb topbar__crumb--last">{{ 'Sync-In' | translate: locale.language }}</span>
        }
        @for (b of segments(); track $index; let i = $index; let last = $last) {
          @if (i > 0) {
            <app-v2-icon name="chevRight" [size]="11" class="topbar__crumb-sep" />
          }
          @if (!last && b.route) {
            <button type="button" class="topbar__crumb topbar__crumb--link" (click)="navigate(b.route)">
              @if (b.icon) {
                <app-v2-icon [name]="b.icon" [size]="13" class="topbar__crumb-icon" />
              }
              <span class="topbar__crumb-label">{{ b.label | translate: locale.language }}</span>
            </button>
          } @else {
            <span class="topbar__crumb topbar__crumb--last">
              @if (b.icon) {
                <app-v2-icon [name]="b.icon" [size]="13" class="topbar__crumb-icon" />
              }
              <span class="topbar__crumb-label">{{ b.label | translate: locale.language }}</span>
            </span>
          }
        }
      </nav>

      <div class="topbar__spacer"></div>

      <form class="topbar__search" (submit)="onSearchSubmit($event)" role="search">
        <app-v2-icon name="search" [size]="14" class="topbar__search-icon" />
        <input #searchInput type="search" class="topbar__search-input" [placeholder]="placeholder()" autocomplete="off" />
        <span class="topbar__search-kbd" aria-hidden="true">{{ shortcutLabel }}</span>
      </form>

      <div class="topbar__actions">
        <app-v2-transfers-popover />
        <app-v2-notifications-bell />
        <a class="topbar__avatar" [routerLink]="settingsRoute" [attr.title]="'Settings' | translate: locale.language">
          <app-v2-avatar [user]="meAvatar()" [size]="28" />
        </a>
      </div>
    </header>
  `,
  styleUrl: './top-bar.component.scss'
})
export class TopBarComponent {
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private readonly translation = inject(L10nTranslationService)
  private readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  private readonly layoutV2 = inject(LayoutV2Service)
  private readonly store = inject(StoreService)
  protected readonly segments = this.breadcrumbs.segments
  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput')

  // Avatar trigger at the top-right — clicks through to /v2/settings, same
  // destination as the cog button on the left-nav user-card. Funnels into
  // the same shared <app-v2-avatar> renderer (gradient + initials) so the
  // same person renders consistently in both surfaces.
  private readonly user = toSignal(this.store.user)
  private readonly userAvatar = toSignal(this.store.userAvatarUrl)
  protected readonly meAvatar = computed<AvatarUser>(() => {
    const u = this.user()
    const seed = u?.login ?? u?.fullName ?? ''
    return {
      initials: avatarInitials(u?.fullName ?? u?.login ?? '?'),
      hue: avatarHue(seed),
      imageUrl: this.userAvatar() ?? null
    }
  })
  protected readonly settingsRoute = `/${V2_PATH}/${V2_ROUTES.SETTINGS}`

  // Mac uses ⌘, everything else gets Ctrl. Computed once on construction —
  // the platform doesn't change during the session.
  protected readonly shortcutLabel: string = (() => {
    if (typeof navigator === 'undefined') return 'Ctrl K'
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '') || /Mac/.test(navigator.userAgent || '')
    return isMac ? '⌘ K' : 'Ctrl K'
  })()

  protected readonly placeholder = computed(() => {
    const key = this.layoutV2.isMobile() ? 'Search…' : 'Search files…'
    return this.translation.translate(key)
  })

  // Global ⌘K / Ctrl-K — focuses the top-bar search no matter which screen
  // is mounted. Listening on the host catches the event before screens. We
  // don't preventDefault unless we'll actually act, so browser bookmarks bar
  // shortcuts (etc.) keep working when no top-bar is rendered.
  @HostListener('document:keydown', ['$event'])
  onKeydown(ev: KeyboardEvent): void {
    if (ev.key !== 'k' && ev.key !== 'K') return
    if (!(ev.metaKey || ev.ctrlKey)) return
    const el = this.searchInput()?.nativeElement
    if (!el) return
    ev.preventDefault()
    el.focus()
    el.select()
  }

  // History chevs use the browser's history stack rather than Router state
  // because the v2 shell sits inside the same window history as the classic
  // UI — we want "back" to land wherever the user actually came from, not
  // just the previous v2 route.
  protected goBack(): void {
    if (typeof history !== 'undefined') history.back()
  }

  protected goForward(): void {
    if (typeof history !== 'undefined') history.forward()
  }

  protected navigate(route: string | string[] | undefined): void {
    if (!route) return
    this.router.navigate(Array.isArray(route) ? route : [route]).catch(console.error)
  }

  protected onSearchSubmit(ev: Event): void {
    ev.preventDefault()
    const el = this.searchInput()?.nativeElement
    const q = (el?.value ?? '').trim()
    const queryParams = q.length >= 2 ? { q } : undefined
    this.router
      .navigate(['/', V2_PATH, V2_ROUTES.SEARCH], queryParams ? { queryParams } : {})
      .then((ok) => {
        if (ok && el) el.value = ''
      })
      .catch(console.error)
  }
}
