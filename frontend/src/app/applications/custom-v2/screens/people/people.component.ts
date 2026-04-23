import { TitleCasePipe } from '@angular/common'
import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core'
import { USER_ONLINE_STATUS } from '@sync-in-server/backend/src/applications/users/constants/user'
import { UserOnlineModel } from '../../../users/models/user-online.model'
import { StoreService } from '../../../../store/store.service'
import { IconV2Component } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'

@Component({
  selector: 'app-v2-people',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './people.component.html',
  styleUrl: './people.component.scss',
  imports: [IconV2Component, TitleCasePipe]
})
export class PeopleComponent implements OnInit {
  private readonly store = inject(StoreService)
  private readonly breadcrumbs = inject(V2BreadcrumbService)

  protected readonly users = this.store.onlineUsers
  protected readonly filter = signal('')
  protected readonly selectedId = signal<number | null>(null)

  protected readonly filteredUsers = computed(() => {
    const q = this.filter().toLowerCase().trim()
    const list = this.users()
    const filtered = q
      ? list.filter((u) => u.fullName.toLowerCase().includes(q) || u.login.toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q))
      : list
    return [...filtered].sort((a, b) => a.fullName.localeCompare(b.fullName))
  })

  protected readonly selected = computed(() => {
    const id = this.selectedId()
    if (id === null) return this.filteredUsers()[0] ?? null
    return this.filteredUsers().find((u) => u.id === id) ?? this.filteredUsers()[0] ?? null
  })

  protected readonly onlineCount = computed(() => this.users().filter((u) => u.onlineStatus !== USER_ONLINE_STATUS.OFFLINE).length)

  ngOnInit(): void {
    this.breadcrumbs.setBreadcrumbs([{ label: 'People', icon: 'person' }])
  }

  protected onFilterInput(ev: Event): void {
    this.filter.set((ev.target as HTMLInputElement).value)
  }

  protected selectUser(u: UserOnlineModel): void {
    this.selectedId.set(u.id)
  }

  protected statusClass(u: UserOnlineModel): string {
    switch (u.onlineStatus) {
      case USER_ONLINE_STATUS.AVAILABLE:
        return 'people-row__status--online'
      case USER_ONLINE_STATUS.ABSENT:
        return 'people-row__status--away'
      case USER_ONLINE_STATUS.BUSY:
        return 'people-row__status--busy'
      default:
        return 'people-row__status--offline'
    }
  }

  protected hueForUser(u: UserOnlineModel): number {
    let h = 0
    for (let i = 0; i < u.login.length; i++) h = (h * 31 + u.login.charCodeAt(i)) >>> 0
    return h % 360
  }

  protected initials(u: UserOnlineModel): string {
    const parts = (u.fullName || u.login || '').trim().split(/\s+/).filter(Boolean)
    return (
      parts
        .slice(0, 2)
        .map((p) => p[0])
        .join('')
        .toUpperCase() || '?'
    )
  }
}
