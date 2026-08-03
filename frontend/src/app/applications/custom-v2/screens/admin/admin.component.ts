import { ChangeDetectionStrategy, Component, inject, OnInit } from '@angular/core'
import { RouterLink } from '@angular/router'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { IconV2Component, IconV2Name } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'

interface AdminCard {
  id: string
  title: string
  description: string
  icon: IconV2Name
  route: string
  disabled?: boolean
  disabledReason?: string
}

@Component({
  selector: 'app-v2-admin',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconV2Component, RouterLink, L10nTranslateDirective, L10nTranslatePipe],
  template: `
    <div class="admin">
      <header class="admin__head">
        <h1 class="admin__title" l10nTranslate>Administration</h1>
        <p class="admin__lede" l10nTranslate>Manage users, groups, spaces, and server-level tools.</p>
      </header>
      <div class="admin__grid">
        @for (c of cards; track c.id) {
          @if (c.disabled) {
            <div class="admin-card admin-card--disabled" [attr.title]="c.disabledReason | translate: locale.language">
              <div class="admin-card__icon">
                <app-v2-icon [name]="c.icon" [size]="20" />
              </div>
              <div class="admin-card__body">
                <div class="admin-card__title">{{ c.title | translate: locale.language }}</div>
                <div class="admin-card__desc">{{ c.description | translate: locale.language }}</div>
              </div>
            </div>
          } @else {
            <a [routerLink]="c.route" class="admin-card">
              <div class="admin-card__icon">
                <app-v2-icon [name]="c.icon" [size]="20" />
              </div>
              <div class="admin-card__body">
                <div class="admin-card__title">{{ c.title | translate: locale.language }}</div>
                <div class="admin-card__desc">{{ c.description | translate: locale.language }}</div>
              </div>
            </a>
          }
        }
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
        min-height: 0;
        background: var(--si-bg2);
      }
      .admin {
        padding: var(--si-space-12) var(--si-space-13);
        display: flex;
        flex-direction: column;
        gap: 22px;
        max-width: 980px;
      }
      .admin__head {
        display: flex;
        flex-direction: column;
        gap: var(--si-space-2);
      }
      /* Page-title scale shared with every other v2 screen (#405 item 5). */
      .admin__title {
        margin: 0;
        font-size: var(--si-text-15);
        font-weight: 500;
        color: var(--si-fg);
        letter-spacing: -0.018em;
        line-height: 1.15;
        font-family: var(--si-display);
      }
      .admin__lede {
        margin: 0;
        font-size: var(--si-text-10);
        line-height: 1.4;
        color: var(--si-fg-muted);
      }
      .admin__grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
        gap: var(--si-space-6);
      }
      .admin-card {
        display: flex;
        align-items: flex-start;
        gap: var(--si-space-7);
        padding: var(--si-space-7) var(--si-space-8);
        background: var(--si-bg3);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r3);
        text-decoration: none;
        color: inherit;
        cursor: pointer;
        transition:
          background 120ms ease,
          border-color 120ms ease;

        &:hover {
          background: var(--si-bg4);
          border-color: var(--si-line-strong);
        }
        &--disabled {
          opacity: 0.55;
          cursor: not-allowed;
          &:hover {
            background: var(--si-bg3);
            border-color: var(--si-line);
          }
        }
      }
      .admin-card__icon {
        width: 36px;
        height: 36px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: var(--si-r2);
        background: var(--si-nav-soft);
        color: var(--si-accent-ink);
        flex-shrink: 0;
      }
      .admin-card__body {
        display: flex;
        flex-direction: column;
        gap: var(--si-space-2);
        min-width: 0;
      }
      .admin-card__title {
        font-size: var(--si-text-9);
        font-weight: 600;
        color: var(--si-fg);
        letter-spacing: -0.1px;
      }
      .admin-card__desc {
        font-size: var(--si-text-6);
        color: var(--si-fg-muted);
        line-height: 1.35;
      }
    `
  ]
})
export class AdminComponent implements OnInit {
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private readonly breadcrumbs = inject(V2BreadcrumbService)

  protected readonly cards: AdminCard[] = [
    {
      id: 'users',
      title: 'Users',
      description: 'Create, edit, disable, or delete accounts.',
      icon: 'person',
      route: `/${V2_PATH}/${V2_ROUTES.ADMIN_USERS}`
    },
    {
      id: 'groups',
      title: 'Groups',
      description: 'Create groups and manage membership.',
      icon: 'box',
      route: `/${V2_PATH}/${V2_ROUTES.ADMIN_GROUPS}`
    },
    {
      id: 'spaces',
      title: 'Spaces',
      description: 'Review all spaces on the server.',
      icon: 'folder',
      route: `/${V2_PATH}/${V2_ROUTES.ADMIN_SPACES}`
    },
    {
      id: 'tools',
      title: 'Tools',
      description: 'Re-index, stats, server diagnostics.',
      icon: 'more',
      route: `/${V2_PATH}/${V2_ROUTES.ADMIN_TOOLS}`
    }
  ]

  ngOnInit(): void {
    this.breadcrumbs.setBreadcrumbs([{ label: 'Administration', icon: 'person' }])
  }
}
