import { ChangeDetectionStrategy, Component, DestroyRef, inject, OnInit, signal } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { IndexingState, IndexingStatus } from '@sync-in-server/backend/src/applications/files/interfaces/indexing.interface'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { switchMap, timer } from 'rxjs'
import { AdminService } from '../../../admin/admin.service'
import { ButtonComponent } from '../../components/button.component'
import { ConfirmDialogService } from '../../components/confirm-dialog.service'
import { ToastService } from '../../components/toast.service'
import { IconV2Component } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'

function formatDate(ts: number | null | undefined): string {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

@Component({
  selector: 'app-v2-admin-tools',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconV2Component, L10nTranslateDirective, L10nTranslatePipe],
  template: `
    <div class="at">
      <header class="at__head">
        <h1 class="at__title" l10nTranslate>Tools</h1>
        <p class="at__lede" l10nTranslate>Server-level maintenance tasks.</p>
      </header>

      <section class="at-card">
        <div class="at-card__head">
          <div class="at-card__title-wrap">
            <div class="at-card__icon">
              <app-v2-icon name="search" [size]="16" />
            </div>
            <div>
              <div class="at-card__title" l10nTranslate>Full-text indexing</div>
              <div class="at-card__desc" l10nTranslate>
                Indexes file contents so search can look inside documents. Stop before taking the server down for maintenance.
              </div>
            </div>
          </div>
          <span class="at-badge" [class]="'at-badge--' + badgeKind(status().state)">{{
            stateLabel(status().state) | translate: locale.language
          }}</span>
        </div>

        <dl class="at-stats">
          <div class="at-stat">
            <dt l10nTranslate>Indexes</dt>
            <dd class="at-stat__mono">{{ status().indexesCount.toLocaleString() }}</dd>
          </div>
          <div class="at-stat">
            <dt l10nTranslate>Last full run</dt>
            <dd class="at-stat__mono">{{ status().lastFullRunAt ? formatDate(status().lastFullRunAt) : ('Never' | translate: locale.language) }}</dd>
          </div>
          <div class="at-stat">
            <dt l10nTranslate>Last partial run</dt>
            <dd class="at-stat__mono">
              {{ status().lastPartialRunAt ? formatDate(status().lastPartialRunAt) : ('Never' | translate: locale.language) }}
            </dd>
          </div>
        </dl>

        <div class="at-actions">
          @if (status().state === IndexingState.RUNNING) {
            <app-v2-btn kind="ghost" size="sm" icon="x" [disabled]="busy()" (click)="stop()">{{ 'Stop' | translate: locale.language }}</app-v2-btn>
          } @else {
            <app-v2-btn
              kind="primary"
              size="sm"
              icon="refresh"
              [disabled]="busy() || status().state === IndexingState.STOPPING || status().state === IndexingState.DISABLED"
              (click)="start()"
            >
              {{ 'Start' | translate: locale.language }}
            </app-v2-btn>
          }
          <app-v2-btn
            kind="ghost"
            size="sm"
            icon="trash"
            [disabled]="busy() || status().indexesCount === 0 || (status().state !== IndexingState.IDLE && status().state !== IndexingState.DISABLED)"
            (click)="drop()"
          >
            {{ 'Drop indexes' | translate: locale.language }}
          </app-v2-btn>
        </div>

        @if (errorMessage(); as err) {
          <div class="at-card__error">{{ err }}</div>
        }
      </section>
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
      .at {
        padding: 22px 28px;
        display: flex;
        flex-direction: column;
        gap: 20px;
        max-width: 720px;
      }
      .at__head {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .at__title {
        margin: 0;
        font-size: 20px;
        font-weight: 700;
        color: var(--si-fg);
        letter-spacing: -0.3px;
        font-family: var(--si-display);
      }
      .at__lede {
        margin: 0;
        font-size: 13px;
        color: var(--si-fg-muted);
      }

      .at-card {
        display: flex;
        flex-direction: column;
        gap: 16px;
        padding: 18px 20px;
        background: var(--si-bg3);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r3);
      }
      .at-card__head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 14px;
      }
      .at-card__title-wrap {
        display: flex;
        gap: 12px;
        align-items: flex-start;
      }
      .at-card__icon {
        width: 32px;
        height: 32px;
        border-radius: var(--si-r2);
        background: var(--si-nav-soft);
        color: var(--si-nav);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .at-card__title {
        font-size: 14px;
        font-weight: 600;
        color: var(--si-fg);
        letter-spacing: -0.1px;
      }
      .at-card__desc {
        margin-top: 2px;
        font-size: 12.5px;
        color: var(--si-fg-muted);
        line-height: 1.4;
        max-width: 460px;
      }
      .at-card__error {
        color: var(--si-rose);
        font-size: 12px;
      }

      .at-badge {
        display: inline-flex;
        padding: 3px 10px;
        border-radius: 999px;
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: 0.8px;
        text-transform: uppercase;
        font-family: var(--si-display);
        flex-shrink: 0;

        &--running {
          background: var(--si-green-soft, rgba(80, 180, 120, 0.2));
          color: oklch(0.86 0.13 155);
        }
        &--stopping {
          background: var(--si-amber-soft, rgba(220, 160, 40, 0.2));
          color: oklch(0.82 0.15 75);
        }
        &--idle {
          background: var(--si-bg4);
          color: var(--si-fg-muted);
        }
        &--disabled {
          background: var(--si-bg4);
          color: var(--si-fg-faint);
        }
      }

      .at-stats {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 10px;
        margin: 0;
        padding: 14px;
        background: var(--si-bg2);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r2);
      }
      .at-stat {
        display: flex;
        flex-direction: column;
        gap: 3px;
        min-width: 0;
      }
      .at-stat dt {
        margin: 0;
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 1px;
        color: var(--si-fg-faint);
        font-weight: 600;
      }
      .at-stat dd {
        margin: 0;
        font-size: 12.5px;
        color: var(--si-fg);
      }
      .at-stat__mono {
        font-family: var(--si-mono);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .at-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }
    `
  ]
})
export class AdminToolsComponent implements OnInit {
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  protected readonly IndexingState = IndexingState
  private readonly admin = inject(AdminService)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  private readonly toast = inject(ToastService)
  private readonly confirm = inject(ConfirmDialogService)
  private readonly destroyRef = inject(DestroyRef)

  protected readonly status = signal<IndexingStatus>({
    indexesCount: 0,
    state: IndexingState.IDLE,
    lastFullRunAt: null,
    lastPartialRunAt: null
  })
  protected readonly busy = signal(false)
  protected readonly errorMessage = signal<string | null>(null)

  protected readonly formatDate = formatDate

  ngOnInit(): void {
    this.breadcrumbs.setBreadcrumbs([{ label: 'Administration', icon: 'person', route: ['/', V2_PATH, V2_ROUTES.ADMIN] }, { label: 'Tools' }])
    // Poll every 6s while the screen is mounted. Matches classic's cadence.
    timer(0, 6_000)
      .pipe(
        switchMap(() => this.admin.indexingStatus()),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe({
        next: (r) => {
          this.status.set({ ...r })
          this.errorMessage.set(null)
        },
        error: () => this.errorMessage.set('Failed to load indexing status')
      })
  }

  protected stateLabel(state: IndexingState): string {
    switch (state) {
      case IndexingState.RUNNING:
        return 'running'
      case IndexingState.STOPPING:
        return 'stopping'
      case IndexingState.DISABLED:
        return 'disabled'
      default:
        return 'idle'
    }
  }

  protected badgeKind(state: IndexingState): string {
    switch (state) {
      case IndexingState.RUNNING:
        return 'running'
      case IndexingState.STOPPING:
        return 'stopping'
      case IndexingState.DISABLED:
        return 'disabled'
      default:
        return 'idle'
    }
  }

  protected start(): void {
    this.busy.set(true)
    this.admin.startIndexing().subscribe({
      next: (started) => {
        this.busy.set(false)
        if (started) {
          this.status.update((s) => ({ ...s, state: IndexingState.RUNNING }))
          this.toast.success('Indexing started')
        }
      },
      error: () => {
        this.busy.set(false)
        this.toast.error('Unable to start indexing')
      }
    })
  }

  protected stop(): void {
    this.busy.set(true)
    this.admin.stopIndexing().subscribe({
      next: (stopped) => {
        this.busy.set(false)
        if (stopped) {
          this.status.update((s) => ({ ...s, state: IndexingState.STOPPING }))
          this.toast.success('Indexing stopping')
        }
      },
      error: () => {
        this.busy.set(false)
        this.toast.error('Unable to stop indexing')
      }
    })
  }

  protected async drop(): Promise<void> {
    const ok = await this.confirm.open({
      title: 'Drop indexes',
      message: 'v3_drop_indexes',
      confirmLabel: 'Drop',
      kind: 'danger'
    })
    if (!ok) return
    this.busy.set(true)
    this.admin.dropIndexes().subscribe({
      next: () => {
        this.busy.set(false)
        this.status.update((s) => ({ ...s, indexesCount: 0 }))
        this.toast.success('Indexes dropped')
      },
      error: () => {
        this.busy.set(false)
        this.toast.error('Unable to drop indexes')
      }
    })
  }
}
