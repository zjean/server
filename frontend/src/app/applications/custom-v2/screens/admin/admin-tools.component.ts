import { ChangeDetectionStrategy, Component, DestroyRef, inject, OnInit, signal } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { VERSIONS_ADMIN_TOP_ROOTS } from '@sync-in-server/backend/src/applications/custom-versioning/constants/versioning'
import type {
  VersionsRootUsage,
  VersionsStorageSummary
} from '@sync-in-server/backend/src/applications/custom-versioning/interfaces/version.interface'
import { IndexingState, IndexingStatus } from '@sync-in-server/backend/src/applications/files/interfaces/indexing.interface'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { switchMap, timer } from 'rxjs'
import { ToBytesPipe } from '../../../../common/pipes/to-bytes.pipe'
import { AdminService } from '../../../admin/admin.service'
import { ButtonComponent } from '../../components/button.component'
import { ConfirmDialogService } from '../../components/confirm-dialog.service'
import { ToastService } from '../../components/toast.service'
import { IconV2Component } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { isVersioningDisabledError, VersionsAdminService } from '../../services/versions-admin.service'
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
  imports: [ButtonComponent, IconV2Component, L10nTranslateDirective, L10nTranslatePipe, ToBytesPipe],
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
          <!-- danger, not ghost: dropping every index is destructive, and read as
               neutral beside Start/Refresh until #399. -->
          <app-v2-btn
            kind="danger"
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

      <!--
        File version storage (#342). Read-only, plus one destructive action.
        Version bytes are charged against USER quota, so this is the only place
        an operator can answer "why is this user out of space".
      -->
      <section class="at-card">
        <div class="at-card__head">
          <div class="at-card__title-wrap">
            <div class="at-card__icon">
              <app-v2-icon name="clock" [size]="16" />
            </div>
            <div>
              <div class="at-card__title" l10nTranslate>File version storage</div>
              <div class="at-card__desc" l10nTranslate>
                Version history is charged against the quota of the user or space that owns it. Purging removes unnamed versions only.
              </div>
            </div>
          </div>
          @if (versionsDisabled()) {
            <span class="at-badge at-badge--disabled">{{ 'disabled' | translate: locale.language }}</span>
          }
        </div>

        @if (versionsDisabled()) {
          <div class="at-card__desc" l10nTranslate>File versioning is turned off on this server.</div>
        } @else if (storage(); as s) {
          <dl class="at-stats at-stats--4">
            <div class="at-stat">
              <dt l10nTranslate>Total size</dt>
              <dd class="at-stat__mono">{{ s.used | toBytes: 1 : true }}</dd>
            </div>
            <div class="at-stat">
              <dt l10nTranslate>Versions</dt>
              <dd class="at-stat__mono">{{ s.count.toLocaleString() }}</dd>
            </div>
            <div class="at-stat">
              <dt l10nTranslate>Files</dt>
              <dd class="at-stat__mono">{{ s.files.toLocaleString() }}</dd>
            </div>
            <div class="at-stat">
              <dt l10nTranslate>Named</dt>
              <dd class="at-stat__mono">{{ s.labeledBytes | toBytes: 1 : true }}</dd>
            </div>
          </dl>

          @if (s.topRoots.length) {
            <div class="at-sub">
              {{ 'v2_versions_top_roots' | translate: locale.language : { count: topRoots, total: s.roots } }}
            </div>
            <div class="at-table-wrap">
              <table class="at-table">
                <thead>
                  <tr>
                    <th l10nTranslate>Owner</th>
                    <th class="at-table__num" l10nTranslate>Size</th>
                    <th class="at-table__num" l10nTranslate>Versions</th>
                    <th class="at-table__num" l10nTranslate>Files</th>
                    <th class="at-table__num" l10nTranslate>Cap</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of s.topRoots; track r.versionsRoot) {
                    <tr>
                      <td>
                        <span class="at-kind">{{ (r.kind === 'space' ? 'Space' : 'User') | translate: locale.language }}</span>
                        <span class="at-table__mono">{{ r.name }}</span>
                      </td>
                      <td class="at-table__num at-table__mono">
                        {{ r.used | toBytes: 1 : true }}
                        @if (r.labeledBytes) {
                          <span class="at-table__hint">{{
                            'v2_versions_named_bytes' | translate: locale.language : { bytes: bytes(r.labeledBytes) }
                          }}</span>
                        }
                      </td>
                      <td class="at-table__num at-table__mono">{{ r.count.toLocaleString() }}</td>
                      <td class="at-table__num at-table__mono">{{ r.files.toLocaleString() }}</td>
                      <!--
                        A null ceiling means no cap applies to this root. The backend
                        reports it from the same function that enforces it, so "Not
                        capped" is the honest answer rather than a missing number.
                      -->
                      <td class="at-table__num at-table__mono">
                        {{ r.ceiling === null ? ('Not capped' | translate: locale.language) : (r.ceiling | toBytes: 1 : true) }}
                      </td>
                      <td class="at-table__num">
                        <app-v2-btn kind="danger" size="sm" icon="trash" [disabled]="!!purging()" (click)="purge(r)">
                          {{ 'Purge' | translate: locale.language }}
                        </app-v2-btn>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <div class="at-card__desc" l10nTranslate>No version history has been recorded yet.</div>
          }
        } @else if (!versionsError()) {
          <div class="at-card__desc" l10nTranslate>Loading…</div>
        }

        @if (versionsError(); as err) {
          <div class="at-card__error">{{ err | translate: locale.language }}</div>
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
        // 820 to match the Settings column (#399). At 720 these cards stopped
        // ~310px short of the admin tables on the sibling admin screens, which
        // made the section look unfinished — and the per-owner table inside the
        // versions card was cramped for no reason.
        max-width: 820px;
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

      .at-stats--4 {
        grid-template-columns: repeat(4, 1fr);
      }

      .at-sub {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 1px;
        color: var(--si-fg-faint);
        font-weight: 600;
      }

      /* The table can outgrow a narrow window; it scrolls inside its own box so
         the screen never scrolls sideways. */
      .at-table-wrap {
        overflow-x: auto;
        border: 1px solid var(--si-line);
        border-radius: var(--si-r2);
      }
      .at-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12.5px;
      }
      .at-table th {
        text-align: left;
        padding: 8px 12px;
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 1px;
        color: var(--si-fg-faint);
        font-weight: 600;
        background: var(--si-bg2);
        white-space: nowrap;
      }
      .at-table td {
        padding: 7px 12px;
        border-top: 1px solid var(--si-line);
        color: var(--si-fg);
        vertical-align: middle;
        white-space: nowrap;
      }
      .at-table__num {
        text-align: right;
      }
      .at-table__mono {
        font-family: var(--si-mono);
      }
      .at-table__hint {
        display: block;
        font-size: 10.5px;
        color: var(--si-fg-faint);
      }
      .at-kind {
        display: inline-block;
        margin-right: 8px;
        padding: 1px 7px;
        border-radius: 999px;
        background: var(--si-bg4);
        color: var(--si-fg-muted);
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.6px;
        font-weight: 600;
      }
    `
  ]
})
export class AdminToolsComponent implements OnInit {
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  protected readonly IndexingState = IndexingState
  private readonly admin = inject(AdminService)
  private readonly versionsAdmin = inject(VersionsAdminService)
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

  // Version storage (#342). `null` while loading; `versionsDisabled` is the
  // feature-off case, which is not an error and must not read as one.
  protected readonly storage = signal<VersionsStorageSummary | null>(null)
  protected readonly versionsDisabled = signal(false)
  protected readonly versionsError = signal<string | null>(null)
  // The root currently being purged, so its row's action disables without a
  // second boolean to keep in sync.
  protected readonly purging = signal<string | null>(null)
  protected readonly topRoots = VERSIONS_ADMIN_TOP_ROOTS

  protected readonly formatDate = formatDate
  // The bytes formatter is needed in TypeScript too — toast and confirm-dialog
  // strings interpolate it as a parameter, where a template pipe cannot reach.
  private readonly toBytes = new ToBytesPipe()

  ngOnInit(): void {
    this.breadcrumbs.setBreadcrumbs([{ label: 'Administration', icon: 'person', route: ['/', V2_PATH, V2_ROUTES.ADMIN] }, { label: 'Tools' }])
    this.loadStorage()
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
      message: 'v2_drop_indexes',
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

  /* ------------------------------------------------- version storage (#342) */

  protected bytes(n: number): string {
    return this.toBytes.transform(n, 1, true)
  }

  private loadStorage(): void {
    this.versionsAdmin
      .storage()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (s) => {
          this.storage.set(s)
          this.versionsDisabled.set(false)
          this.versionsError.set(null)
        },
        error: (e: unknown) => {
          // Feature off is a state to report, not a failure to log: every
          // versions endpoint 404s while `files.versions.enabled` is false.
          if (isVersioningDisabledError(e)) {
            this.versionsDisabled.set(true)
            this.versionsError.set(null)
            return
          }
          this.versionsError.set('Failed to load version storage')
        }
      })
  }

  /**
   * Deletes one root's unnamed version history.
   *
   * Confirmed first, and deliberately named in the confirmation: this is not
   * undoable and it removes another person's data. Named versions survive, so the
   * result is reported rather than assumed — a root that still shows bytes
   * afterwards is showing its named revisions, not a failed purge.
   */
  protected async purge(root: VersionsRootUsage): Promise<void> {
    const ok = await this.confirm.open({
      title: 'Purge version history',
      message: 'v2_versions_purge_confirm',
      messageParams: { name: root.name, bytes: this.bytes(root.used) },
      confirmLabel: 'Purge',
      kind: 'danger'
    })
    if (!ok) return
    this.purging.set(root.versionsRoot)
    this.versionsAdmin.purge(root.versionsRoot).subscribe({
      next: (r) => {
        this.purging.set(null)
        this.toast.success('v2_versions_purged', { count: r.removed, bytes: this.bytes(r.removedBytes) })
        if (r.keptLabeled) {
          this.toast.info('v2_versions_purge_kept', { count: r.keptLabeled })
        }
        // Re-read rather than patch the row: the purge changed the totals, the
        // ranking and possibly whether this root appears at all.
        this.loadStorage()
      },
      error: () => {
        this.purging.set(null)
        this.toast.error('Purge failed')
      }
    })
  }
}
