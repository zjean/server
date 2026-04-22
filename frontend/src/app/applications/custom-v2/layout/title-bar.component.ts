import { Location } from '@angular/common'
import { ChangeDetectionStrategy, Component, inject } from '@angular/core'
import { Router } from '@angular/router'
import { Subscription } from 'rxjs'
import { StoreService } from '../../../store/store.service'
import { UserType } from '../../users/interfaces/user.interface'
import { IconV2Component } from '../icons/icon-v2.component'
import { IconButtonComponent } from '../components/icon-button.component'
import { LogoComponent } from '../components/logo.component'
import { V2BreadcrumbService } from './breadcrumb.service'

@Component({
  selector: 'app-v2-title-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './title-bar.component.html',
  styleUrl: './title-bar.component.scss',
  imports: [IconV2Component, IconButtonComponent, LogoComponent]
})
export class TitleBarComponent {
  private readonly location = inject(Location)
  private readonly router = inject(Router)
  private readonly store = inject(StoreService)
  protected readonly breadcrumbs = inject(V2BreadcrumbService).segments
  protected user: UserType | null = null
  protected userAvatar: string | null = null
  private subscriptions: Subscription[] = []

  constructor() {
    this.subscriptions.push(this.store.user.subscribe((user: UserType) => (this.user = user)))
    this.subscriptions.push(this.store.userAvatarUrl.subscribe((avatar: string) => (this.userAvatar = avatar)))
  }

  protected back(): void {
    this.location.back()
  }

  protected forward(): void {
    this.location.forward()
  }

  protected navigateSegment(route: string | string[] | undefined): void {
    if (!route) return
    this.router.navigate(Array.isArray(route) ? route : [route]).catch(console.error)
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
