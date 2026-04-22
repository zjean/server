import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core'
import { IconV2Component, IconV2Name } from '../icons/icon-v2.component'

export type DockTabId = 'pencil' | 'bell' | 'flag' | 'info' | 'shareTree' | 'comment'

interface DockTab {
  id: DockTabId
  icon: IconV2Name
  label: string
}

@Component({
  selector: 'app-v2-dock-rail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dock-rail.component.html',
  styleUrl: './dock-rail.component.scss',
  imports: [IconV2Component]
})
export class DockRailComponent {
  @Input() active: DockTabId | null = null
  @Output() readonly dockChange = new EventEmitter<DockTabId | null>()

  protected readonly tabs: DockTab[] = [
    { id: 'pencil', icon: 'pencil', label: 'Edit' },
    { id: 'bell', icon: 'bell', label: 'Notifications' },
    { id: 'flag', icon: 'flag', label: 'Tasks' },
    { id: 'info', icon: 'info', label: 'Info' },
    { id: 'shareTree', icon: 'shareTree', label: 'Sharing' },
    { id: 'comment', icon: 'comment', label: 'Comments' }
  ]

  protected toggle(id: DockTabId): void {
    this.dockChange.emit(this.active === id ? null : id)
  }
}
