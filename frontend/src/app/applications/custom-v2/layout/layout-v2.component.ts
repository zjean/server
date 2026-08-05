import { ChangeDetectionStrategy, Component, HostListener, inject, OnInit, ViewEncapsulation } from '@angular/core'
import { RouterOutlet } from '@angular/router'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { CompressDialogComponent } from '../components/compress-dialog.component'
import { ConfirmDialogComponent } from '../components/confirm-dialog.component'
import { LockDialogComponent } from '../components/lock-dialog.component'
import { PromptDialogComponent } from '../components/prompt-dialog.component'
import { SheetDragDirective } from '../components/sheet-drag.directive'
import { ShortcutsDialogComponent } from '../components/shortcuts-dialog.component'
import { ShareDialogComponent } from '../components/share-dialog.component'
import { ToastHostComponent } from '../components/toast-host.component'
import { TreePickerComponent } from '../components/tree-picker.component'
import { TwoFaDialogComponent } from '../components/two-fa-dialog.component'
import { setUiVersion } from '../ui-version'
import { BottomTabBarComponent } from './bottom-tab-bar.component'
import { InspectorPanelComponent } from './inspector-panel.component'
import { DOCK_WIDTH_MAX, DOCK_WIDTH_MIN, LayoutV2Service } from './layout-v2.service'
import { LeftNavComponent } from './left-nav.component'
import { PageBreadcrumbComponent } from './page-breadcrumb.component'
import { SessionStripComponent } from './session-strip.component'
import { TitleBarComponent } from './title-bar.component'
import { TopBarComponent } from './top-bar.component'
import { UploadDockComponent } from './upload-dock.component'

@Component({
  selector: 'app-layout-v2',
  templateUrl: './layout-v2.component.html',
  styleUrls: ['../styles/fonts.scss', '../styles/v2.scss', './layout-v2.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'v2-root',
    '[class.layout-v2--mobile]': 'layoutV2.isMobile()',
    '[class.layout-v2--overlay-open]': 'layoutV2.leftNavOpen() || layoutV2.dockVisible()'
  },
  imports: [
    RouterOutlet,
    SheetDragDirective,
    TitleBarComponent,
    TopBarComponent,
    LeftNavComponent,
    PageBreadcrumbComponent,
    SessionStripComponent,
    InspectorPanelComponent,
    UploadDockComponent,
    ToastHostComponent,
    ConfirmDialogComponent,
    TreePickerComponent,
    PromptDialogComponent,
    CompressDialogComponent,
    LockDialogComponent,
    ShareDialogComponent,
    TwoFaDialogComponent,
    ShortcutsDialogComponent,
    BottomTabBarComponent,
    L10nTranslateDirective,
    L10nTranslatePipe
  ]
})
export class LayoutV2Component implements OnInit {
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  protected readonly layoutV2 = inject(LayoutV2Service)
  protected readonly dockWidthMin = DOCK_WIDTH_MIN
  protected readonly dockWidthMax = DOCK_WIDTH_MAX
  private resizeRaf: number | null = null
  private dockResizeCleanup: (() => void) | null = null

  ngOnInit() {
    setUiVersion('v2')
  }

  // Skip link target. The sidebar puts ~20 focusable items between the top of
  // the document and the content on every route, and there was no way past
  // them from the keyboard. `main` carries tabindex="-1" so it can take focus
  // programmatically without joining the tab order itself.
  protected focusMainContent(): void {
    if (typeof document === 'undefined') return
    const main = document.getElementById('v2-main-content')
    if (!main) return
    main.focus()
    main.scrollTop = 0
  }

  @HostListener('window:resize')
  onResize(): void {
    if (this.resizeRaf !== null) return
    this.resizeRaf = requestAnimationFrame(() => {
      this.resizeRaf = null
      this.layoutV2.syncViewport(window.innerWidth)
    })
  }

  // Panel resize. The width is `viewport - pointer`, because the panel is
  // anchored right; the service clamps to 300–520 so the arithmetic here never
  // has to. Only the pointerup persists — a pointermove per pixel would write
  // localStorage a few hundred times per drag.
  protected startDockResize(ev: PointerEvent): void {
    if (typeof window === 'undefined') return
    ev.preventDefault()
    this.dockResizeCleanup?.()
    const onMove = (e: PointerEvent) => this.layoutV2.setDockWidth(window.innerWidth - e.clientX, false)
    const onUp = (e: PointerEvent) => {
      this.layoutV2.setDockWidth(window.innerWidth - e.clientX)
      this.dockResizeCleanup?.()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    document.body.classList.add('v2-resizing-col')
    this.dockResizeCleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.classList.remove('v2-resizing-col')
      this.dockResizeCleanup = null
    }
  }

  // A drag handle that only responds to a pointer is unusable from the keyboard,
  // and this one is in the tab order because it is a real separator.
  protected onDockGripKey(ev: KeyboardEvent): void {
    const step = ev.shiftKey ? 40 : 16
    if (ev.key === 'ArrowLeft') this.layoutV2.setDockWidth(this.layoutV2.dockWidth() + step)
    else if (ev.key === 'ArrowRight') this.layoutV2.setDockWidth(this.layoutV2.dockWidth() - step)
    else return
    ev.preventDefault()
  }

  // The mobile scrim this handles is the drawer's alone since `M3` — the inspector
  // sheet has its own, wired straight to closeDock().
  protected onBackdropClick(): void {
    this.layoutV2.closeLeftNav()
  }
}
