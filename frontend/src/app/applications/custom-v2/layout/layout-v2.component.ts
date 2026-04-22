import { Component, HostBinding, OnInit, signal, ViewEncapsulation } from '@angular/core'
import { RouterOutlet } from '@angular/router'
import { setUiVersion } from '../ui-version'
import { AppRailComponent } from './app-rail.component'
import { DockRailComponent, DockTabId } from './dock-rail.component'
import { LeftNavComponent } from './left-nav.component'
import { TitleBarComponent } from './title-bar.component'

@Component({
  selector: 'app-layout-v2',
  templateUrl: './layout-v2.component.html',
  styleUrls: ['../styles/v2.scss', './layout-v2.component.scss'],
  encapsulation: ViewEncapsulation.None,
  imports: [RouterOutlet, TitleBarComponent, AppRailComponent, LeftNavComponent, DockRailComponent]
})
export class LayoutV2Component implements OnInit {
  @HostBinding('class.v2-root') readonly v2Root = true

  protected readonly dockActive = signal<DockTabId | null>(null)

  ngOnInit() {
    setUiVersion('v2')
  }

  protected onDockChange(tab: DockTabId | null): void {
    this.dockActive.set(tab)
  }
}
