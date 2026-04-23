import { ChangeDetectionStrategy, Component, computed, inject, OnInit } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { Router } from '@angular/router'
import { APP_VERSION } from '../../../../app.constants'
import { ToBytesPipe } from '../../../../common/pipes/to-bytes.pipe'
import { StoreService } from '../../../../store/store.service'
import { USER_PATH } from '../../../users/user.constants'
import { IconV2Component, IconV2Name } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'

interface SettingLink {
  id: string
  icon: IconV2Name
  title: string
  description: string
  classicPath: string
}

@Component({
  selector: 'app-v2-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
  imports: [IconV2Component, ToBytesPipe]
})
export class SettingsComponent implements OnInit {
  private readonly store = inject(StoreService)
  private readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)

  protected readonly user = toSignal(this.store.user)
  protected readonly userAvatar = toSignal(this.store.userAvatarUrl)
  protected readonly version = APP_VERSION

  protected readonly initials = computed(() => {
    const u = this.user()
    if (!u) return '?'
    const parts = (u.fullName || u.login || '').trim().split(/\s+/).filter(Boolean)
    return (
      parts
        .slice(0, 2)
        .map((p) => p[0])
        .join('')
        .toUpperCase() || '?'
    )
  })

  protected readonly storagePercent = computed(() => {
    const u = this.user()
    if (!u?.storageQuota || u.storageQuota <= 0) return 0
    return Math.min(100, Math.round(((u.storageUsage ?? 0) / u.storageQuota) * 100))
  })

  protected readonly settingsLinks: SettingLink[] = [
    { id: 'account', icon: 'person', title: 'Account', description: 'Name, email, password, language', classicPath: `/${USER_PATH.BASE}` },
    { id: 'security', icon: 'lock', title: 'Security', description: 'Two-factor authentication, recovery codes', classicPath: `/${USER_PATH.BASE}` },
    {
      id: 'applications',
      icon: 'code',
      title: 'App passwords',
      description: 'Tokens for sync clients and API access',
      classicPath: `/${USER_PATH.BASE}/applications`
    },
    { id: 'groups', icon: 'people', title: 'Groups', description: 'Personal groups you manage', classicPath: `/${USER_PATH.BASE}/groups` }
  ]

  ngOnInit(): void {
    this.breadcrumbs.setBreadcrumbs([{ label: 'Settings', icon: 'settings' }])
  }

  protected openClassic(path: string): void {
    this.router.navigateByUrl(path).catch(console.error)
  }
}
