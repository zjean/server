import { ChangeDetectionStrategy, Component, inject } from '@angular/core'
import { Subscription } from 'rxjs'
import { StoreService } from '../../../store/store.service'
import { UserType } from '../../users/interfaces/user.interface'
import { LogoComponent } from '../components/logo.component'
import { LayoutV2Service } from './layout-v2.service'
import { NotificationsBellComponent } from './notifications-bell.component'

@Component({
  selector: 'app-v2-title-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './title-bar.component.html',
  styleUrl: './title-bar.component.scss',
  imports: [LogoComponent, NotificationsBellComponent]
})
export class TitleBarComponent {
  protected readonly layoutV2 = inject(LayoutV2Service)
  private readonly store = inject(StoreService)
  protected user: UserType | null = null
  protected userAvatar: string | null = null
  private subscriptions: Subscription[] = []

  constructor() {
    this.subscriptions.push(this.store.user.subscribe((user: UserType) => (this.user = user)))
    this.subscriptions.push(this.store.userAvatarUrl.subscribe((avatar: string) => (this.userAvatar = avatar)))
  }

  protected onBrandClick(): void {
    this.layoutV2.toggleLeftNav()
  }

  protected userInitials(): string {
    if (!this.user) return ''
    const parts = (this.user.fullName ?? '').trim().split(/\s+/).filter(Boolean)
    const letters = parts
      .slice(0, 2)
      .map((p) => p[0])
      .join('')
    return letters.toUpperCase() || (this.user.login ?? '').slice(0, 2).toUpperCase()
  }
}
