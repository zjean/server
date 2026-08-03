import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, input, signal } from '@angular/core'
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop'
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { filter } from 'rxjs/operators'
import { ToBytesPipe } from '../../../common/pipes/to-bytes.pipe'
import { StoreService } from '../../../store/store.service'
import { AvatarComponent, AvatarUser, avatarHue, avatarInitials } from '../components/avatar.component'
import { LogoComponent } from '../components/logo.component'
import { IconV2Component, IconV2Name } from '../icons/icon-v2.component'
import { clearUiVersion } from '../ui-version'
import { V2_PATH, V2_ROUTES } from '../v2.constants'
import { LayoutV2Service } from './layout-v2.service'

interface NavEntry {
  id: string
  label: string
  icon: IconV2Name
  route: string
}

@Component({
  selector: 'app-v2-left-nav',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './left-nav.component.html',
  styleUrl: './left-nav.component.scss',
  host: {
    '[class.left-nav--open]': 'layoutV2.leftNavOpen()',
    '[class.left-nav--compact]': 'compact()',
    '[class.left-nav--overlay]': 'forceFullRender()',
    '[attr.id]': "forceFullRender() ? 'v2-left-nav-overlay' : 'v2-left-nav'",
    '[attr.role]': "isDialogMode() ? 'dialog' : null",
    '[attr.aria-modal]': "isDialogMode() ? 'true' : null",
    '[attr.aria-label]': "isDialogMode() ? 'Navigation' : null"
  },
  imports: [IconV2Component, AvatarComponent, LogoComponent, RouterLink, RouterLinkActive, ToBytesPipe, L10nTranslateDirective, L10nTranslatePipe]
})
export class LeftNavComponent {
  protected readonly layoutV2 = inject(LayoutV2Service)
  private readonly store = inject(StoreService)
  private readonly router = inject(Router)
  private readonly destroyRef = inject(DestroyRef)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  // When true, this instance renders its full sidebar even if
  // sidebarCollapsed() is set — used by the desktop overlay placement so
  // the same component drives both the persistent rail and the temporary
  // expanded overlay.
  readonly forceFullRender = input(false)

  protected readonly user = toSignal(this.store.user)
  protected readonly userAvatar = toSignal(this.store.userAvatarUrl)
  protected readonly sharedOpen = signal(true)
  protected readonly adminOpen = signal(true)
  protected readonly isDialogMode = computed(
    () =>
      (this.layoutV2.isMobile() && this.layoutV2.leftNavOpen()) ||
      (!this.layoutV2.isMobile() && this.forceFullRender() && this.layoutV2.sidebarOverlay())
  )

  // True when this instance should render as the 48px icon rail. The
  // overlay instance (forceFullRender=true) always renders full.
  protected readonly compact = computed(() => !this.layoutV2.isMobile() && this.layoutV2.sidebarCollapsed() && !this.forceFullRender())

  protected readonly meAvatar = computed<AvatarUser>(() => {
    const u = this.user()
    const seed = u?.login ?? u?.fullName ?? ''
    return {
      initials: avatarInitials(u?.fullName ?? u?.login ?? ''),
      hue: avatarHue(seed),
      imageUrl: this.userAvatar() ?? null
    }
  })

  protected readonly workspace: NavEntry[] = [
    { id: 'search', label: 'Search', icon: 'search', route: `/${V2_PATH}/${V2_ROUTES.SEARCH}` },
    { id: 'recents', label: 'Recents', icon: 'clock', route: `/${V2_PATH}/${V2_ROUTES.RECENTS}` },
    { id: 'favorites', label: 'Favorites', icon: 'star', route: `/${V2_PATH}/${V2_ROUTES.FAVORITES}` },
    { id: 'personal', label: 'Personal', icon: 'folder', route: `/${V2_PATH}/${V2_ROUTES.PERSONAL}` },
    { id: 'spaces', label: 'Spaces', icon: 'box', route: `/${V2_PATH}/${V2_ROUTES.SPACES}` }
  ]

  protected readonly sharedEntries: NavEntry[] = [
    { id: 'shared-with-me', label: 'With me', icon: 'person', route: `/${V2_PATH}/${V2_ROUTES.SHARED_WITH_ME}` },
    { id: 'shared-with-others', label: 'With others', icon: 'arrowUp', route: `/${V2_PATH}/${V2_ROUTES.SHARED_WITH_OTHERS}` },
    { id: 'shared-via-links', label: 'Via links', icon: 'link', route: `/${V2_PATH}/${V2_ROUTES.SHARED_VIA_LINKS}` }
  ]

  protected readonly adminEntries: NavEntry[] = [
    { id: 'admin-users', label: 'Users', icon: 'person', route: `/${V2_PATH}/${V2_ROUTES.ADMIN_USERS}` },
    { id: 'admin-groups', label: 'Groups', icon: 'box', route: `/${V2_PATH}/${V2_ROUTES.ADMIN_GROUPS}` }
  ]

  protected readonly peopleRoute = `/${V2_PATH}/${V2_ROUTES.PEOPLE}`
  // Group MEMBERSHIP (classic's /user/groups), not the admin group registry —
  // it sits beside People because both are directory screens, and unlike
  // adminEntries it needs no role.
  protected readonly groupsRoute = `/${V2_PATH}/${V2_ROUTES.GROUPS}`
  protected readonly trashRoute = `/${V2_PATH}/${V2_ROUTES.TRASH}`
  protected readonly settingsRoute = `/${V2_PATH}/${V2_ROUTES.SETTINGS}`
  // Sidebar header (wordmark) is desktop-only — mobile already shows the
  // wordmark via the title-bar's brand button, so an extra header in the
  // drawer would duplicate it. Also hidden in compact rail mode.
  protected readonly showHeader = computed(() => !this.layoutV2.isMobile() && !this.compact())

  // AGPL §13 source link — required when the server is deployed for anyone
  // but the maintainer. Lives in the LeftNav footer so it's visible on every
  // v2 page and discharges the network clause for the v2 tree.
  protected readonly sourceUrl = 'https://github.com/zjean/server'

  constructor() {
    this.router.events
      .pipe(
        filter((ev): ev is NavigationEnd => ev instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(() => {
        if (this.layoutV2.isMobile() && this.layoutV2.leftNavOpen()) {
          this.layoutV2.closeLeftNav()
        }
        if (!this.layoutV2.isMobile() && this.layoutV2.sidebarOverlay()) {
          this.layoutV2.closeSidebarOverlay()
        }
      })
  }

  protected toggleShared(): void {
    this.sharedOpen.update((v) => !v)
  }

  protected toggleAdmin(): void {
    this.adminOpen.update((v) => !v)
  }

  protected backToClassic(): void {
    clearUiVersion()
    this.router.navigate(['/']).catch(console.error)
  }

  protected openOverlay(): void {
    this.layoutV2.openSidebarOverlay()
  }

  // Header collapse button. In the desktop overlay (collapsed-rail user has
  // temporarily expanded the full nav over content), the right action is to
  // dismiss the overlay back to the rail — calling toggleSidebar() there
  // would un-collapse and lose the rail. In normal expanded mode, just
  // toggle collapse.
  protected dismissSidebar(): void {
    if (this.forceFullRender()) {
      this.layoutV2.closeSidebarOverlay()
    } else {
      this.layoutV2.toggleSidebar()
    }
  }
}
