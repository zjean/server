import { HttpErrorResponse } from '@angular/common/http'
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  EventEmitter,
  inject,
  Input,
  OnChanges,
  Output,
  signal,
  SimpleChanges
} from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { FormsModule } from '@angular/forms'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe, L10nTranslationService } from 'angular-l10n'
import { ToBytesPipe } from '../../../common/pipes/to-bytes.pipe'
import { TimeAgoPipe } from '../../../common/pipes/time-ago.pipe'
import { userAvatarUrl } from '../../users/user.functions'
import { isDiffableFile, VersionModel, VersionsUsage, versionsUsageRatio } from '../models/version.model'
import { VersionsService } from '../services/versions.service'
import { AvatarComponent, avatarTone, avatarInitials, AvatarUser } from './avatar.component'
import { ButtonComponent } from './button.component'
import { ConfirmDialogService } from './confirm-dialog.service'
import { ContextMenuAnchor, ContextMenuComponent, ContextMenuEntry } from './context-menu.component'
import { IconButtonComponent } from './icon-button.component'
import { PillComponent } from './pill.component'
import { ToastService } from './toast.service'
import { VersionsDiffComponent } from './versions-diff.component'

/** What the host's tab strip and panel header label this history with. */
export interface VersionsStats {
  count: number
  /** Bytes this FILE's history holds — not the root-scoped quota figure. */
  bytes: number
}

interface VersionRow extends VersionModel {
  // Inline label editing, mirroring how comments-panel handles an edit in place.
  editing: boolean
  draft: string
  // One in-flight action per row, so its buttons disable rather than queueing.
  busy: boolean
  avatar: AvatarUser
  // Absolute timestamps for the title attribute. `amTimeAgo` gives "2 days ago",
  // which is the right default and the wrong thing to squint at when deciding
  // which revision to restore.
  timesTitle: string
  // Positional handle — `v3` is the third-oldest row CURRENTLY held, not a stored
  // identity. Deleting or thinning a row renumbers the ones below it, which is
  // fine for a label and would not be for a reference: every action here keys on
  // `id`.
  ordinal: number
  // How this revision's size compares with the content that replaced it, which is
  // the next-newer row or — for the newest row — the live file. Two saves in the
  // same minute are indistinguishable without it.
  delta: number
}

/**
 * Version history for a single file. Consumed by the inspector as a tab beside
 * Comments.
 *
 * Rows are labeled with `mtime` — when the revision's own bytes were written —
 * because the question being asked here is "restore it to how it was on…".
 * `createdAt` (when the overwrite retired the revision) is in the tooltip on the
 * same line, since the two can be far apart and the difference matters exactly
 * once: when a file edited long ago is overwritten today.
 *
 * The card follows D5: ONE primary action. `Restore` is a real button; `Compare`
 * and `Download` are ghost; naming and deleting a version live in the overflow
 * menu, because both are rarer than restoring and one of them is destructive.
 *
 * Permissions are the server's to decide, and they mirror the live file: anyone
 * who can read the file can list and download its history, while restore, label
 * and delete need MODIFY. This panel does not pre-hide those actions, matching
 * the rest of custom-v2 — no v2 screen gates on space permissions today (the
 * file browser offers rename and delete to every viewer and lets the guard
 * refuse), so a denied action surfaces the server's own message here too. Worth
 * fixing everywhere at once rather than inventing a local rule here that drifts
 * from the guard.
 */
@Component({
  selector: 'app-v2-versions-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AvatarComponent,
    ButtonComponent,
    ContextMenuComponent,
    IconButtonComponent,
    PillComponent,
    VersionsDiffComponent,
    FormsModule,
    ToBytesPipe,
    TimeAgoPipe,
    L10nTranslateDirective,
    L10nTranslatePipe
  ],
  template: `
    <div class="vp">
      @if (loading()) {
        <div class="vp__state" l10nTranslate>Loading…</div>
      } @else if (errorMessage(); as err) {
        <div class="vp__state vp__state--error">{{ err | translate: locale.language }}</div>
      } @else {
        <div class="vp__scroll">
          @if (rows().length === 0) {
            <div class="vp__state">
              <div l10nTranslate>No earlier versions yet</div>
              <div class="vp__state-lede" l10nTranslate>A version is kept each time this file's contents are replaced.</div>
            </div>
          } @else {
            <ul class="vp__list">
              @for (r of rows(); track r.id) {
                <li class="vp-row" [class.vp-row--busy]="r.busy">
                  <div class="vp-row__head">
                    <span class="vp-row__ordinal">v{{ r.ordinal }}</span>
                    @if (r.isLabeled && !r.editing) {
                      <app-v2-pill color="amber">{{ r.label }}</app-v2-pill>
                    } @else {
                      <!-- Neutral, always: a byte delta is information, not a
                           warning, and this badge shares a line with the version
                           handle it must not outrank. -->
                      <app-v2-pill color="gray">{{ deltaLabel(r) }}</app-v2-pill>
                    }
                    <span class="vp-row__spacer"></span>
                    <span class="vp-row__when" [attr.title]="r.timesTitle">{{ r.mtime | amTimeAgo }}</span>
                  </div>

                  <div class="vp-row__author">
                    <app-v2-avatar [user]="r.avatar" [size]="20" />
                    <span class="vp-row__who">{{ r.author?.name ?? ('Unknown' | translate: locale.language) }}</span>
                    <span class="vp-row__origin">· {{ r.size | toBytes: 1 : true }} · {{ r.originLabel | translate: locale.language }}</span>
                  </div>

                  @if (r.editing) {
                    <div class="vp-row__editor">
                      <input
                        class="vp-row__input"
                        type="text"
                        maxlength="255"
                        [placeholder]="'Version name' | translate: locale.language"
                        [(ngModel)]="r.draft"
                        (keydown.enter)="saveLabel(r)"
                        (keydown.escape)="cancelLabel(r)"
                      />
                      <div class="vp-row__editor-actions">
                        <app-v2-btn kind="ghost" size="sm" (click)="cancelLabel(r)">{{ 'Cancel' | translate: locale.language }}</app-v2-btn>
                        <app-v2-btn kind="primary" size="sm" [disabled]="r.busy" (click)="saveLabel(r)">
                          {{ 'Save' | translate: locale.language }}
                        </app-v2-btn>
                      </div>
                    </div>
                  } @else {
                    <div class="vp-row__actions">
                      <app-v2-btn kind="secondary" size="sm" icon="restore" [disabled]="r.busy" (click)="restore(r)">{{
                        'Restore' | translate: locale.language
                      }}</app-v2-btn>
                      @if (diffable) {
                        <app-v2-btn
                          kind="ghost"
                          size="sm"
                          icon="code"
                          [disabled]="r.busy"
                          [title]="'Compare with the current file' | translate: locale.language"
                          (click)="toggleDiff(r)"
                          >{{ (diffFor() === r.id ? 'Close' : 'Compare') | translate: locale.language }}</app-v2-btn
                        >
                      }
                      <app-v2-icon-btn
                        iconName="download"
                        [size]="30"
                        [disabled]="r.busy"
                        [title]="'Download this version' | translate: locale.language"
                        [ariaLabel]="'Download this version' | translate: locale.language"
                        (click)="download(r)"
                      />
                      <span class="vp-row__spacer"></span>
                      <app-v2-icon-btn
                        iconName="more"
                        [size]="30"
                        [disabled]="r.busy"
                        [title]="'More' | translate: locale.language"
                        [ariaLabel]="'More' | translate: locale.language"
                        (click)="openRowMenu(r, $event)"
                      />
                    </div>
                  }

                  @if (diffFor() === r.id) {
                    <div class="vp-row__diff">
                      @if (diffLoading()) {
                        <div class="vp__state" l10nTranslate>Loading…</div>
                      } @else if (diffError(); as derr) {
                        <div class="vp__state vp__state--error">{{ derr | translate: locale.language }}</div>
                      } @else if (diffIdentical()) {
                        <div class="vp__state" l10nTranslate>Identical to the current file.</div>
                      } @else {
                        <app-v2-versions-diff [diff]="diffText()" />
                      }
                    </div>
                  }
                </li>
              }
            </ul>
          }
        </div>

        <!-- A footer below a divider, not a card: the quota story belongs out of
             the scan path but still on screen, because turning versioning on
             reduces every user's effective quota (ADR §7). Shown even with an
             empty list — that is when it is news. -->
        @if (usage(); as u) {
          <div class="vp__footer">
            <!-- "ALL version history": this figure is root-scoped (the whole
                 space's history), while the panel header's is this file's. Same
                 word on both would read as one number contradicting itself. -->
            <div class="vp__footer-row">
              <span l10nTranslate>All version history</span>
              <span class="vp__footer-value">
                @if (u.ceiling) {
                  {{ bytes(u.used) }} / {{ bytes(u.ceiling) }}
                } @else {
                  {{ bytes(u.used) }}
                }
              </span>
            </div>
            @if (usageRatio(); as ratio) {
              <div class="vp__usage-bar" role="presentation">
                <div class="vp__usage-fill" [class.vp__usage-fill--full]="ratio >= 0.9" [style.width.%]="ratio * 100"></div>
              </div>
            }
            <div class="vp__footer-note" l10nTranslate>Version history counts towards your storage quota.</div>
          </div>
        }
      }
    </div>
    <app-v2-context-menu [items]="menuItems()" [open]="menuFor() !== null" [anchor]="menuAnchor()" (closed)="closeRowMenu()" />
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        flex: 1 1 auto;
        min-height: 0;
        min-width: 0;
      }
      .vp {
        display: flex;
        flex-direction: column;
        flex: 1 1 auto;
        min-height: 0;
      }
      .vp__scroll {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        padding: var(--si-space-9) var(--si-space-10);
      }
      .vp__state {
        padding: var(--si-space-9) var(--si-space-5);
        font-size: var(--si-text-6);
        color: var(--si-fg-tertiary);
        text-align: center;

        &--error {
          color: var(--si-rose-ink);
        }
      }
      .vp__state-lede {
        margin-top: var(--si-space-2);
        font-size: var(--si-text-4);
        color: var(--si-fg-ghost);
      }
      .vp__list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--si-space-5);
      }
      /* A card on the panel: one surface step up from bg1, no border. The border
         was doing the work the surface step does. */
      .vp-row {
        background: var(--si-bg2);
        border-radius: var(--si-r2);
        padding: var(--si-space-6) var(--si-space-7);

        &--busy {
          opacity: 0.6;
        }
      }
      .vp-row__head {
        display: flex;
        align-items: center;
        gap: var(--si-space-4);
        min-width: 0;
        margin-bottom: var(--si-space-5);
      }
      .vp-row__spacer {
        flex: 1 1 auto;
      }
      /* A version handle is machine output, so mono — and it is the card's entry
         point, so it takes the bright tone. */
      .vp-row__ordinal {
        font-family: var(--si-mono);
        font-size: var(--si-text-6);
        font-weight: 500;
        color: var(--si-fg);
      }
      .vp-row__when {
        font-family: var(--si-mono);
        font-size: var(--si-text-4);
        color: var(--si-fg-tertiary);
        white-space: nowrap;
      }
      .vp-row__author {
        display: flex;
        align-items: center;
        gap: var(--si-space-4);
        min-width: 0;
      }
      .vp-row__who {
        font-size: var(--si-text-7);
        color: var(--si-fg-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .vp-row__origin {
        font-family: var(--si-mono);
        font-size: var(--si-text-3);
        color: var(--si-fg-ghost);
        white-space: nowrap;
      }
      .vp-row__actions {
        display: flex;
        align-items: center;
        gap: var(--si-space-3);
        margin-top: var(--si-space-5);
      }
      .vp-row__editor {
        margin-top: var(--si-space-5);
        display: flex;
        flex-direction: column;
        gap: var(--si-space-4);
      }
      /* Mirrors app-v2-input: filled, with a resting hairline because the fill
         alone measures 1.11:1 against the plane. */
      .vp-row__input {
        background: var(--si-bg3);
        border: 1px solid var(--si-border);
        border-radius: var(--si-r1);
        padding: var(--si-space-4) var(--si-space-5);
        color: var(--si-fg);
        font-family: var(--si-sans);
        font-size: var(--si-text-7);

        &:focus {
          border-color: var(--si-focus-ring);
          outline: 2px solid var(--si-focus-ring);
          outline-offset: 1px;
        }
        /* muted, not tertiary: bg3 fill, where tertiary is 4.37. Same call as
           app-v2-input and the comments composer. */
        &::placeholder {
          color: var(--si-fg-muted);
        }
      }
      .vp-row__editor-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--si-space-3);
      }
      .vp-row__diff {
        margin-top: var(--si-space-5);
        min-width: 0;
      }
      .vp__footer {
        flex: 0 0 auto;
        border-top: 1px solid var(--si-line-subtle);
        padding: var(--si-space-7) var(--si-space-10) var(--si-space-9);
        display: flex;
        flex-direction: column;
        gap: var(--si-space-4);
      }
      .vp__footer-row {
        display: flex;
        justify-content: space-between;
        gap: var(--si-space-5);
        font-size: var(--si-text-6);
        color: var(--si-fg-tertiary);
      }
      .vp__footer-value {
        font-family: var(--si-mono);
      }
      .vp__usage-bar {
        height: 4px;
        border-radius: 2px;
        background: var(--si-bg3);
        overflow: hidden;
      }
      .vp__usage-fill {
        height: 100%;
        background: var(--si-accent-hover);

        &--full {
          background: var(--si-rose);
        }
      }
      .vp__footer-note {
        font-size: var(--si-text-4);
        color: var(--si-fg-ghost);
        line-height: 1.55;
      }
    `
  ]
})
export class VersionsPanelComponent implements OnChanges {
  // The Sync-in space path of the file (`files/personal/notes/todo.md`), plain
  // and undecorated — the service encodes it.
  @Input({ required: true }) filePath!: string
  @Input({ required: true }) fileId!: number
  // Stored-form mime and current size. The mime decides whether to offer a text
  // comparison; the size is what the newest revision's delta is measured against.
  @Input() mime: string | null = null
  @Input() size = 0

  // A restore replaces the live file's bytes, so whatever renders that file is
  // now stale. The host reloads; this panel does not guess what to refresh.
  @Output() readonly restored = new EventEmitter<void>()

  // How many revisions there are and what they weigh, for the host's tab count
  // and panel header. Reported rather than fetched twice: this panel is the thing
  // that loads the list, so it is the only place that knows. It follows that the
  // count exists only once the tab has been opened — which is why nothing outside
  // the inspector (a row badge, say) is driven from it.
  @Output() readonly statsChange = new EventEmitter<VersionsStats>()

  private readonly versions = inject(VersionsService)
  private readonly confirm = inject(ConfirmDialogService)
  private readonly toast = inject(ToastService)
  private readonly translation = inject(L10nTranslationService)
  private readonly destroyRef = inject(DestroyRef)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  protected readonly rows = signal<VersionRow[]>([])
  protected readonly usage = signal<VersionsUsage | null>(null)
  protected readonly loading = signal(true)
  protected readonly errorMessage = signal<string | null>(null)

  protected readonly diffFor = signal<number | null>(null)
  protected readonly diffText = signal('')
  protected readonly diffIdentical = signal(false)
  protected readonly diffLoading = signal(false)
  protected readonly diffError = signal<string | null>(null)

  protected readonly menuFor = signal<VersionRow | null>(null)
  protected readonly menuAnchor = signal<ContextMenuAnchor | null>(null)

  // Recomputed on input change rather than per render: it depends only on the
  // file, not on any row.
  protected diffable = false

  protected readonly menuItems = computed<ContextMenuEntry[]>(() => {
    const r = this.menuFor()
    if (!r) return []
    return [
      {
        id: 'label',
        label: r.isLabeled ? 'Rename this version' : 'Name this version',
        icon: 'pencil',
        action: () => this.startLabel(r)
      },
      { id: 'sep', kind: 'divider' },
      { id: 'delete', label: 'Delete', icon: 'trash', kind: 'danger', action: () => void this.remove(r) }
    ]
  })

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['mime'] || changes['size']) {
      this.diffable = isDiffableFile(this.mime, this.size)
    }
    if (changes['filePath'] || changes['fileId']) {
      this.closeDiff()
      this.load()
    } else if (changes['size']) {
      // The live size is the newest row's comparison point, so a save that only
      // changed the size still moves every delta.
      this.rows.update((list) => this.decorate(list))
    }
  }

  protected usageRatio(): number | null {
    return versionsUsageRatio(this.usage())
  }

  // Byte counts are interpolated into a translated sentence, so they are
  // formatted here rather than applied by the `toBytes` pipe in the template.
  private readonly toBytes = new ToBytesPipe()

  protected bytes(n: number): string {
    return this.toBytes.transform(n, 1, true)
  }

  /** `+123 B`, `−48 B`, `±0 B`. Machine output, so no translation. */
  protected deltaLabel(r: VersionRow): string {
    if (r.delta === 0) return '±0 B'
    const sign = r.delta > 0 ? '+' : '−'
    return `${sign}${this.bytes(Math.abs(r.delta))}`
  }

  /* ----------------------------------------------------------------- load */

  private load(): void {
    if (!this.filePath || !this.fileId) return
    this.loading.set(true)
    this.errorMessage.set(null)
    this.versions
      .list(this.filePath)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (list) => {
          this.rows.set(this.decorate(list.map((v) => this.buildRow(v))))
          this.loading.set(false)
          this.emitStats()
          this.loadUsage()
        },
        error: (e: HttpErrorResponse) => {
          this.errorMessage.set(e.error?.message ?? 'Failed to load versions')
          this.loading.set(false)
        }
      })
  }

  // Usage is a separate, root-scoped number with its own request. A failure here
  // hides the usage block and nothing else — the history itself is still usable,
  // so this deliberately does not surface an error.
  private loadUsage(): void {
    this.versions
      .usage(this.filePath)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (u) => this.usage.set(u),
        error: () => this.usage.set(null)
      })
  }

  private emitStats(): void {
    const list = this.rows()
    this.statsChange.emit({ count: list.length, bytes: list.reduce((sum, r) => sum + r.size, 0) })
  }

  // Ordinal and delta are both positional, so they are recomputed for the whole
  // list whenever it changes rather than stored per row at build time.
  // The API returns newest-first, so index 0 is the most recent revision and the
  // content that replaced it is the LIVE file.
  private decorate(list: VersionRow[]): VersionRow[] {
    const n = list.length
    return list.map((r, i) => ({
      ...r,
      ordinal: n - i,
      delta: (i === 0 ? this.size : list[i - 1].size) - r.size
    }))
  }

  private buildRow(v: VersionModel): VersionRow {
    return {
      ...v,
      editing: false,
      draft: v.label ?? '',
      busy: false,
      avatar: this.buildAvatar(v),
      timesTitle: this.buildTimesTitle(v),
      ordinal: 0,
      delta: 0
    }
  }

  private buildAvatar(v: VersionModel): AvatarUser {
    // No author means a system-originated snapshot or a deleted account, not an
    // error — neutral initials, no image.
    if (!v.author) return { initials: '··', tone: 1, imageUrl: null }
    return {
      initials: avatarInitials(v.author.name),
      tone: avatarTone(v.author.login),
      imageUrl: userAvatarUrl(v.author.login)
    }
  }

  // Both timestamps, spelled out, because the row shows the relative form of
  // only one of them.
  private buildTimesTitle(v: VersionModel): string {
    const modified = new Date(v.mtime).toLocaleString()
    const replaced = v.createdAt.toLocaleString()
    return `${this.translation.translate('Modified')}: ${modified}\n${this.translation.translate('Replaced')}: ${replaced}`
  }

  /* -------------------------------------------------------------- actions */

  // Anchored to the trigger's own bottom-left edge with the design's 4px offset,
  // rather than to the pointer — a menu opened from a button belongs on the
  // button, and this one is also reachable by keyboard.
  protected openRowMenu(r: VersionRow, ev: Event): void {
    const el = ev.currentTarget as HTMLElement | null
    const rect = el?.getBoundingClientRect()
    this.menuAnchor.set(rect ? { x: rect.left, y: rect.bottom + 4 } : { x: 0, y: 0 })
    this.menuFor.set(r)
  }

  protected closeRowMenu(): void {
    this.menuFor.set(null)
    this.menuAnchor.set(null)
  }

  protected download(r: VersionRow): void {
    this.versions.download(this.filePath, r.id)
  }

  protected async restore(r: VersionRow): Promise<void> {
    const date = new Date(r.mtime).toLocaleString()
    // Dialog fields are i18n KEYS — the confirm dialog translates title, message
    // (as innerHTML, so the bold survives) and confirmLabel itself.
    const ok = await this.confirm.open({
      title: 'Restore this version',
      message: 'v2_restore_version',
      messageParams: { date },
      confirmLabel: 'Restore'
    })
    if (!ok) return
    this.setBusy(r.id, true)
    this.versions.restore(this.filePath, r.id).subscribe({
      next: () => {
        this.toast.success('v2_restored_version', { date })
        this.closeDiff()
        // The restore added a version of its own — the content it replaced — so
        // both the list and the usage figure are stale.
        this.load()
        this.restored.emit()
      },
      error: (e: HttpErrorResponse) => {
        this.setBusy(r.id, false)
        this.toast.error(e.error?.message ?? 'Restore failed')
      }
    })
  }

  protected startLabel(r: VersionRow): void {
    this.rows.update((list) => list.map((row) => (row.id === r.id ? { ...row, editing: true, draft: row.label ?? '' } : { ...row, editing: false })))
  }

  protected cancelLabel(r: VersionRow): void {
    this.rows.update((list) => list.map((row) => (row.id === r.id ? { ...row, editing: false, draft: row.label ?? '' } : row)))
  }

  protected saveLabel(r: VersionRow): void {
    const next = r.draft.trim()
    if (next === (r.label ?? '')) {
      this.cancelLabel(r)
      return
    }
    // An emptied field clears the name; the backend treats '' and null alike.
    const label = next || null
    this.setBusy(r.id, true)
    this.versions.setLabel(this.filePath, r.id, label).subscribe({
      next: () => {
        this.rows.update((list) =>
          list.map((row) => (row.id === r.id ? { ...row, label, isLabeled: !!label, editing: false, draft: label ?? '', busy: false } : row))
        )
        this.toast.success(label ? 'Version named' : 'Version name cleared')
      },
      error: (e: HttpErrorResponse) => {
        this.setBusy(r.id, false)
        this.toast.error(e.error?.message ?? 'Failed to name version')
      }
    })
  }

  /**
   * Deletes a version, asking first — and asking differently for a named one.
   *
   * A named version is exempt from retention, the per-file cap and quota
   * eviction, so it is the one revision a user has explicitly said to keep. The
   * API refuses to delete it without `confirmLabeled`; rather than showing a
   * second identical dialog to satisfy that, the single dialog names the version
   * and says what is being given up. Same deliberateness, one fewer box to
   * dismiss without reading.
   */
  protected async remove(r: VersionRow): Promise<void> {
    const ok = await this.confirm.open({
      title: r.isLabeled ? 'Delete this named version' : 'Delete this version',
      message: r.isLabeled ? 'v2_delete_labeled_version' : 'v2_delete_version',
      messageParams: r.isLabeled ? { label: r.label! } : { date: new Date(r.mtime).toLocaleString() },
      confirmLabel: 'Delete',
      kind: 'danger'
    })
    if (!ok) return
    this.setBusy(r.id, true)
    this.versions.remove(this.filePath, r.id, r.isLabeled).subscribe({
      next: () => {
        if (this.diffFor() === r.id) this.closeDiff()
        this.rows.update((list) => this.decorate(list.filter((row) => row.id !== r.id)))
        this.toast.success('Version deleted')
        this.emitStats()
        // Freed bytes change the usage figure.
        this.loadUsage()
      },
      error: (e: HttpErrorResponse) => {
        this.setBusy(r.id, false)
        this.toast.error(e.error?.message ?? 'Delete failed')
      }
    })
  }

  /* ----------------------------------------------------------------- diff */

  protected toggleDiff(r: VersionRow): void {
    if (this.diffFor() === r.id) {
      this.closeDiff()
      return
    }
    this.diffFor.set(r.id)
    this.diffText.set('')
    this.diffIdentical.set(false)
    this.diffError.set(null)
    this.diffLoading.set(true)
    this.versions
      .diff(this.filePath, r.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => {
          this.diffText.set(d.diff)
          this.diffIdentical.set(d.identical)
          this.diffLoading.set(false)
        },
        error: (e: HttpErrorResponse) => {
          // 415 (not text) and 413 (too large, or diverged too far) are ordinary
          // outcomes here, and each carries a message worth showing verbatim.
          this.diffError.set(e.error?.message ?? 'Comparison failed')
          this.diffLoading.set(false)
        }
      })
  }

  private closeDiff(): void {
    this.diffFor.set(null)
    this.diffText.set('')
    this.diffIdentical.set(false)
    this.diffError.set(null)
    this.diffLoading.set(false)
  }

  /* ---------------------------------------------------------------- utils */

  private setBusy(id: number, busy: boolean): void {
    this.rows.update((list) => list.map((row) => (row.id === id ? { ...row, busy } : row)))
  }
}
