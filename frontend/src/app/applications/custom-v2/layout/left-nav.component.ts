import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { Router, RouterLink, RouterLinkActive } from '@angular/router'
import { ToBytesPipe } from '../../../common/pipes/to-bytes.pipe'
import { StoreService } from '../../../store/store.service'
import { IconV2Component, IconV2Name } from '../icons/icon-v2.component'
import { clearUiVersion } from '../ui-version'
import { V2_PATH, V2_ROUTES } from '../v2.constants'

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
  imports: [IconV2Component, RouterLink, RouterLinkActive, ToBytesPipe]
})
export class LeftNavComponent {
  private readonly store = inject(StoreService)
  private readonly router = inject(Router)

  protected readonly user = toSignal(this.store.user)
  protected readonly userAvatar = toSignal(this.store.userAvatarUrl)
  protected readonly sharedOpen = signal(true)
  protected readonly adminOpen = signal(true)

  protected readonly workspace: NavEntry[] = [
    { id: 'recents', label: 'Recents', icon: 'clock', route: `/${V2_PATH}/${V2_ROUTES.RECENTS}` },
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

  protected readonly trashRoute = `/${V2_PATH}/${V2_ROUTES.TRASH}`

  // AGPL §13 source link — required when the server is deployed for anyone
  // but the maintainer. Lives in the LeftNav footer so it's visible on every
  // v2 page and discharges the network clause for the v2 tree.
  protected readonly sourceUrl = 'https://github.com/zjean/server'

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
}
