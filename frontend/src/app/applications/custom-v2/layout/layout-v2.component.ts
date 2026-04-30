import { ChangeDetectionStrategy, Component, HostListener, inject, OnInit, ViewEncapsulation } from '@angular/core'
import { RouterOutlet } from '@angular/router'
import { ConfirmDialogComponent } from '../components/confirm-dialog.component'
import { LinkDialogComponent } from '../components/link-dialog.component'
import { PromptDialogComponent } from '../components/prompt-dialog.component'
import { ShareDialogComponent } from '../components/share-dialog.component'
import { ToastHostComponent } from '../components/toast-host.component'
import { TreePickerComponent } from '../components/tree-picker.component'
import { TwoFaDialogComponent } from '../components/two-fa-dialog.component'
import { PreviewOverlayComponent } from '../preview/preview-overlay.component'
import { setUiVersion } from '../ui-version'
import { AppRailComponent } from './app-rail.component'
import { DockPanelComponent } from './dock-panel.component'
import { DockRailComponent, DockTabId } from './dock-rail.component'
import { LayoutV2Service } from './layout-v2.service'
import { LeftNavComponent } from './left-nav.component'
import { PageBreadcrumbComponent } from './page-breadcrumb.component'
import { TitleBarComponent } from './title-bar.component'
import { TransfersPopoverComponent } from './transfers-popover.component'

@Component({
  selector: 'app-layout-v2',
  templateUrl: './layout-v2.component.html',
  styleUrls: ['../styles/v2.scss', './layout-v2.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'v2-root',
    '[class.layout-v2--mobile]': 'layoutV2.isMobile()',
    '[class.layout-v2--overlay-open]': 'layoutV2.leftNavOpen() || layoutV2.dockActive() !== null'
  },
  imports: [
    RouterOutlet,
    TitleBarComponent,
    AppRailComponent,
    LeftNavComponent,
    PageBreadcrumbComponent,
    DockRailComponent,
    DockPanelComponent,
    TransfersPopoverComponent,
    ToastHostComponent,
    ConfirmDialogComponent,
    TreePickerComponent,
    PromptDialogComponent,
    LinkDialogComponent,
    ShareDialogComponent,
    TwoFaDialogComponent,
    PreviewOverlayComponent
  ]
})
export class LayoutV2Component implements OnInit {
  protected readonly layoutV2 = inject(LayoutV2Service)
  private resizeRaf: number | null = null

  ngOnInit() {
    setUiVersion('v2')
  }

  @HostListener('window:resize')
  onResize(): void {
    if (this.resizeRaf !== null) return
    this.resizeRaf = requestAnimationFrame(() => {
      this.resizeRaf = null
      this.layoutV2.syncViewport(window.innerWidth)
    })
  }

  protected onDockChange(tab: DockTabId | null): void {
    this.layoutV2.setDock(tab)
  }

  protected onBackdropClick(): void {
    if (this.layoutV2.leftNavOpen()) {
      this.layoutV2.closeLeftNav()
      return
    }
    if (this.layoutV2.dockActive() !== null) {
      this.layoutV2.setDock(null)
    }
  }
}
