import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { NavigationEnd, Router, RouterLink } from '@angular/router'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { filter, map, startWith } from 'rxjs/operators'
import { IconV2Component, IconV2Name } from '../icons/icon-v2.component'
import { V2_PATH, V2_ROUTES } from '../v2.constants'

interface TabEntry {
  id: string
  label: string
  icon: IconV2Name
  route: string[]
  // Substring(s) of the URL that mark this tab as active. The first
  // entry that matches the current url wins, so list order doubles as
  // priority.
  matches: string[]
}

// Mobile-only bottom tab bar. Mirrors the Stack mock: 4 destinations
// (Recents, Files, Spaces, Settings) anchored at the viewport bottom,
// each rendered as icon + label. Active tab is brand-colored.
//
// Mounted unconditionally by layout-v2 — the host's CSS gates display
// to .layout-v2--mobile so the bar doesn't take vertical room on
// desktop.
@Component({
  selector: 'app-v2-bottom-tab-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconV2Component, RouterLink, L10nTranslateDirective, L10nTranslatePipe],
  template: `
    <nav class="bb" [attr.aria-label]="'Primary' | translate: locale.language">
      @for (t of tabs; track t.id) {
        <a [routerLink]="t.route" class="bb__tab" [class.bb__tab--active]="activeId() === t.id">
          <app-v2-icon [name]="t.icon" [size]="20" />
          <span class="bb__label" l10nTranslate>{{ t.label }}</span>
        </a>
      }
    </nav>
  `,
  styles: [
    `
      :host {
        display: none;
      }
      :host-context(.layout-v2--mobile) {
        display: block;
      }
      .bb {
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        height: calc(60px + env(safe-area-inset-bottom, 0px));
        padding-bottom: env(safe-area-inset-bottom, 0px);
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        align-items: center;
        background: var(--si-bg1);
        border-top: 1px solid var(--si-line);
        z-index: var(--si-z-panel);
      }
      .bb__tab {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: var(--si-space-2);
        padding: var(--si-space-4) var(--si-space-2);
        background: transparent;
        border: 0;
        font-family: var(--si-sans);
        font-size: var(--si-text-3);
        font-weight: 500;
        letter-spacing: -0.05px;
        color: var(--si-fg-muted);
        cursor: pointer;
        text-decoration: none;
        transition: color var(--si-dur-2) var(--si-ease-out);
      }
      .bb__tab:hover {
        color: var(--si-fg-muted);
      }
      .bb__tab--active,
      .bb__tab--active:hover {
        color: var(--si-accent-ink);
      }
      .bb__label {
        line-height: 1;
      }
    `
  ]
})
export class BottomTabBarComponent {
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private readonly router = inject(Router)

  protected readonly tabs: TabEntry[] = [
    { id: 'recents', label: 'Recents', icon: 'clock', route: ['/', V2_PATH, V2_ROUTES.RECENTS], matches: [`/${V2_PATH}/${V2_ROUTES.RECENTS}`] },
    {
      id: 'files',
      label: 'Files',
      icon: 'folder',
      route: ['/', V2_PATH, V2_ROUTES.PERSONAL],
      matches: [`/${V2_PATH}/${V2_ROUTES.PERSONAL}`, `/${V2_PATH}/${V2_ROUTES.SHARED}`, `/${V2_PATH}/${V2_ROUTES.TRASH}`]
    },
    { id: 'spaces', label: 'Spaces', icon: 'box', route: ['/', V2_PATH, V2_ROUTES.SPACES], matches: [`/${V2_PATH}/${V2_ROUTES.SPACES}`] },
    { id: 'settings', label: 'Settings', icon: 'settings', route: ['/', V2_PATH, V2_ROUTES.SETTINGS], matches: [`/${V2_PATH}/${V2_ROUTES.SETTINGS}`] }
  ]

  // Track the current url so the active-tab class re-evaluates on
  // every navigation. startWith() seeds the initial value because
  // router events only fire after the first nav, so a hard refresh on
  // /v2/personal would otherwise leave every tab inactive until the
  // user clicks something.
  private readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
      startWith(this.router.url)
    ),
    { initialValue: this.router.url }
  )

  protected readonly activeId = computed(() => {
    const url = this.currentUrl()
    for (const t of this.tabs) {
      if (t.matches.some((m) => url.startsWith(m))) return t.id
    }
    return null
  })
}
