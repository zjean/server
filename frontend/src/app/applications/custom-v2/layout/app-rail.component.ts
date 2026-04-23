import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { NavigationEnd, Router, RouterLink } from '@angular/router'
import { filter, startWith } from 'rxjs/operators'
import { IconV2Component, IconV2Name } from '../icons/icon-v2.component'
import { V2_PATH, V2_ROUTES } from '../v2.constants'

interface AppRailItem {
  id: string
  icon: IconV2Name
  title: string
  route: string | null
  disabled: boolean
  matchPrefixes?: string[]
}

@Component({
  selector: 'app-v2-app-rail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app-rail.component.html',
  styleUrl: './app-rail.component.scss',
  imports: [IconV2Component, RouterLink]
})
export class AppRailComponent {
  private readonly router = inject(Router)

  protected readonly items: AppRailItem[] = [
    {
      id: 'files',
      icon: 'folder',
      title: 'Files',
      route: `/${V2_PATH}/${V2_ROUTES.RECENTS}`,
      disabled: false,
      matchPrefixes: [
        `/${V2_PATH}/${V2_ROUTES.RECENTS}`,
        `/${V2_PATH}/${V2_ROUTES.PERSONAL}`,
        `/${V2_PATH}/${V2_ROUTES.SPACES}`,
        `/${V2_PATH}/${V2_ROUTES.SHARED}`,
        `/${V2_PATH}/${V2_ROUTES.TRASH}`,
        `/${V2_PATH}/${V2_ROUTES.VIEWER}`,
        `/${V2_PATH}/${V2_ROUTES.FILE}`
      ]
    },
    { id: 'search', icon: 'search', title: 'Search', route: `/${V2_PATH}/${V2_ROUTES.SEARCH}`, disabled: false },
    { id: 'contacts', icon: 'person', title: 'People — not migrated yet', route: null, disabled: true },
    { id: 'settings', icon: 'settings', title: 'Settings — not migrated yet', route: null, disabled: true }
  ]

  private readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter((ev): ev is NavigationEnd => ev instanceof NavigationEnd),
      startWith({ urlAfterRedirects: this.router.url } as NavigationEnd)
    ),
    { initialValue: { urlAfterRedirects: this.router.url } as NavigationEnd }
  )

  protected readonly activeId = computed<string>(() => {
    const url = this.currentUrl()?.urlAfterRedirects ?? this.router.url
    const match = this.items.find((it) => {
      if (!it.route) return false
      const prefixes = it.matchPrefixes ?? [it.route]
      return prefixes.some((p) => url === p || url.startsWith(p + '/') || url.startsWith(p + '?'))
    })
    return match?.id ?? 'files'
  })
}
