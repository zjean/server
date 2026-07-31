import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output, computed, inject } from '@angular/core'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { IconV2Component } from '../icons/icon-v2.component'
import { DockRailService, DockTab, DockTabId } from './dock-rail.service'

export type { DockTab, DockTabId } from './dock-rail.service'

@Component({
  selector: 'app-v2-dock-rail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dock-rail.component.html',
  styleUrl: './dock-rail.component.scss',
  host: { '[class.dock-rail-host--hidden]': 'tabs().length === 0' },
  imports: [IconV2Component, L10nTranslatePipe]
})
export class DockRailComponent {
  @Input() active: DockTabId | null = null
  @Output() readonly dockChange = new EventEmitter<DockTabId | null>()

  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private readonly dockRail = inject(DockRailService)
  protected readonly tabs = computed<DockTab[]>(() => this.dockRail.tabs())

  protected toggle(id: DockTabId): void {
    this.dockChange.emit(this.active === id ? null : id)
  }
}
