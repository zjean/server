import { ChangeDetectionStrategy, Component } from '@angular/core'
import { IconV2Component, IconV2Name } from '../icons/icon-v2.component'

interface AppRailItem {
  id: string
  icon: IconV2Name
  title: string
  disabled: boolean
}

@Component({
  selector: 'app-v2-app-rail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app-rail.component.html',
  styleUrl: './app-rail.component.scss',
  imports: [IconV2Component]
})
export class AppRailComponent {
  // For milestone 2 only "files" is navigable. The others render but are
  // disabled with tooltips until milestone 3 migrates them.
  protected readonly items: AppRailItem[] = [
    { id: 'files', icon: 'folder', title: 'Files', disabled: false },
    { id: 'search', icon: 'search', title: 'Search — not migrated yet', disabled: true },
    { id: 'contacts', icon: 'person', title: 'People — not migrated yet', disabled: true },
    { id: 'settings', icon: 'settings', title: 'Settings — not migrated yet', disabled: true }
  ]

  // Files is the only navigable entry in m2; it's always the "active" app-rail
  // entry because every v2 route currently lives under files.
  protected readonly activeId = 'files'
}
