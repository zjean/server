import { HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, DestroyRef, EventEmitter, inject, Input, OnChanges, Output, signal, SimpleChanges } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { FormsModule } from '@angular/forms'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe, L10nTranslationService } from 'angular-l10n'
import { ToBytesPipe } from '../../../common/pipes/to-bytes.pipe'
import { TimeAgoPipe } from '../../../common/pipes/time-ago.pipe'
import { userAvatarUrl } from '../../users/user.functions'
import { IconV2Component } from '../icons/icon-v2.component'
import { isDiffableFile, VersionModel, VersionsUsage, versionsUsageRatio } from '../models/version.model'
import { VersionsService } from '../services/versions.service'
import { AvatarComponent, avatarHue, avatarInitials, AvatarUser } from './avatar.component'
import { ButtonComponent } from './button.component'
import { ConfirmDialogService } from './confirm-dialog.service'
import { PillComponent } from './pill.component'
import { ToastService } from './toast.service'
import { VersionsDiffComponent } from './versions-diff.component'

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
}

/**
 * Version history for a single file. Consumed by the file-detail inspector as a
 * tab beside Comments.
 *
 * Rows are labeled with `mtime` — when the revision's own bytes were written —
 * because the question being asked here is "restore it to how it was on…".
 * `createdAt` (when the overwrite retired the revision) is in the tooltip on the
 * same line, since the two can be far apart and the difference matters exactly
 * once: when a file edited long ago is overwritten today.
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
    IconV2Component,
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
                  <app-v2-avatar [user]="r.avatar" [size]="24" />
                  <div class="vp-row__meta">
                    <div class="vp-row__when" [attr.title]="r.timesTitle">{{ r.mtime | amTimeAgo }}</div>
                    <div class="vp-row__sub">
                      {{ r.author?.name ?? ('Unknown' | translate: locale.language) }}
                      · <span class="vp-row__mono">{{ r.size | toBytes: 1 : true }}</span> · {{ r.originLabel | translate: locale.language }}
                    </div>
                  </div>
                  @if (r.isLabeled && !r.editing) {
                    <app-v2-pill color="amber">{{ r.label }}</app-v2-pill>
                  }
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
                    <button
                      class="vp-row__action"
                      type="button"
                      [disabled]="r.busy"
                      (click)="download(r)"
                      [attr.title]="'Download this version' | translate: locale.language"
                    >
                      <app-v2-icon name="download" [size]="12" />
                    </button>
                    @if (diffable) {
                      <button
                        class="vp-row__action"
                        type="button"
                        [class.vp-row__action--on]="diffFor() === r.id"
                        [disabled]="r.busy"
                        (click)="toggleDiff(r)"
                        [attr.title]="'Compare with the current file' | translate: locale.language"
                      >
                        <app-v2-icon name="code" [size]="12" />
                      </button>
                    }
                    <button
                      class="vp-row__action"
                      type="button"
                      [disabled]="r.busy"
                      (click)="startLabel(r)"
                      [attr.title]="'Name this version' | translate: locale.language"
                    >
                      <app-v2-icon name="pencil" [size]="12" />
                    </button>
                    <button
                      class="vp-row__action"
                      type="button"
                      [disabled]="r.busy"
                      (click)="restore(r)"
                      [attr.title]="'Restore this version' | translate: locale.language"
                    >
                      <app-v2-icon name="restore" [size]="12" />
                    </button>
                    <button
                      class="vp-row__action vp-row__action--danger"
                      type="button"
                      [disabled]="r.busy"
                      (click)="remove(r)"
                      [attr.title]="'Delete' | translate: locale.language"
                    >
                      <app-v2-icon name="trash" [size]="12" />
                    </button>
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

        <!-- Shown even with an empty list: the point is that history consumes
             the same quota as files, which is worth knowing BEFORE a history
             exists (ADR §7). -->
        @if (usage(); as u) {
          <div class="vp__usage">
            <div class="vp__usage-text">
              @if (u.ceiling) {
                {{ 'v2_versions_usage' | translate: locale.language : { used: bytes(u.used), ceiling: bytes(u.ceiling) } }}
              } @else {
                {{ 'v2_versions_usage_uncapped' | translate: locale.language : { used: bytes(u.used) } }}
              }
            </div>
            @if (usageRatio(); as ratio) {
              <div class="vp__usage-bar" role="presentation">
                <div class="vp__usage-fill" [class.vp__usage-fill--full]="ratio >= 0.9" [style.width.%]="ratio * 100"></div>
              </div>
            }
            <div class="vp__usage-note" l10nTranslate>Version history counts towards your storage quota.</div>
          </div>
        }
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
      }
      .vp {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 12px 14px;
      }
      .vp__state {
        padding: 18px 10px;
        font-size: var(--si-text-6);
        color: var(--si-fg-muted);
        text-align: center;

        &--error {
          color: var(--si-rose);
        }
      }
      .vp__state-lede {
        margin-top: 4px;
        font-size: var(--si-text-4);
        color: var(--si-fg-faint);
      }
      .vp__list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .vp-row {
        background: var(--si-bg3);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r2);
        padding: 8px 10px;

        &--busy {
          opacity: 0.6;
        }
      }
      .vp-row__head {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .vp-row__meta {
        display: flex;
        flex-direction: column;
        min-width: 0;
        flex: 1 1 auto;
      }
      .vp-row__when {
        font-size: var(--si-text-6);
        font-weight: 600;
        color: var(--si-fg);
        letter-spacing: -0.1px;
      }
      .vp-row__sub {
        font-size: var(--si-text-3);
        color: var(--si-fg-faint);
        overflow-wrap: anywhere;
      }
      .vp-row__mono {
        font-family: var(--si-mono);
      }
      .vp-row__actions {
        display: flex;
        gap: 4px;
        margin-top: 6px;
      }
      .vp-row__action {
        width: 24px;
        height: 24px;
        border-radius: 5px;
        background: transparent;
        border: none;
        cursor: pointer;
        color: var(--si-fg-faint);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;

        &:hover:not(:disabled) {
          background: var(--si-bg4);
          color: var(--si-fg);
        }
        &:disabled {
          cursor: default;
          opacity: 0.5;
        }
        &--on {
          background: var(--si-bg4);
          color: var(--si-fg);
        }
        &--danger:hover:not(:disabled) {
          color: var(--si-rose);
        }
      }
      .vp-row__editor {
        margin-top: 6px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .vp-row__input {
        background: var(--si-bg2);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r1);
        padding: 6px 8px;
        color: var(--si-fg);
        font: inherit;
        font-size: var(--si-text-6);

        &:focus {
          outline: none;
          border-color: var(--si-nav);
        }
        &::placeholder {
          color: var(--si-fg-faint);
        }
      }
      .vp-row__editor-actions {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
      }
      .vp-row__diff {
        margin-top: 8px;
        min-width: 0;
      }
      .vp__usage {
        border-top: 1px solid var(--si-line);
        padding-top: 10px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .vp__usage-text {
        font-size: var(--si-text-5);
        color: var(--si-fg-muted);
      }
      .vp__usage-bar {
        height: 4px;
        border-radius: 2px;
        background: var(--si-bg4);
        overflow: hidden;
      }
      .vp__usage-fill {
        height: 100%;
        background: var(--si-nav);

        &--full {
          background: var(--si-rose);
        }
      }
      .vp__usage-note {
        font-size: var(--si-text-3);
        color: var(--si-fg-faint);
      }
    `
  ]
})
export class VersionsPanelComponent implements OnChanges {
  // The Sync-in space path of the file (`files/personal/notes/todo.md`), plain
  // and undecorated — the service encodes it.
  @Input({ required: true }) filePath!: string
  @Input({ required: true }) fileId!: number
  // Stored-form mime and current size. Used only to decide whether to offer a
  // text comparison.
  @Input() mime: string | null = null
  @Input() size = 0

  // A restore replaces the live file's bytes, so whatever renders that file is
  // now stale. The host reloads; this panel does not guess what to refresh.
  //
  // There is deliberately no count output. A count could only be emitted once
  // this panel has mounted, which happens when the tab is opened — so a badge
  // driven by it would appear only after a visit, which reads as a bug. Doing it
  // properly needs a count on the file props, the way `hasComments` works.
  @Output() readonly restored = new EventEmitter<void>()

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

  // Recomputed on input change rather than per render: it depends only on the
  // file, not on any row.
  protected diffable = false

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['mime'] || changes['size']) {
      this.diffable = isDiffableFile(this.mime, this.size)
    }
    if (changes['filePath'] || changes['fileId']) {
      this.closeDiff()
      this.load()
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
          this.rows.set(list.map((v) => this.buildRow(v)))
          this.loading.set(false)
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

  private buildRow(v: VersionModel): VersionRow {
    return {
      ...v,
      editing: false,
      draft: v.label ?? '',
      busy: false,
      avatar: this.buildAvatar(v),
      timesTitle: this.buildTimesTitle(v)
    }
  }

  private buildAvatar(v: VersionModel): AvatarUser {
    // No author means a system-originated snapshot or a deleted account, not an
    // error — neutral initials, no image.
    if (!v.author) return { initials: '··', hue: 0, imageUrl: null }
    return {
      initials: avatarInitials(v.author.name),
      hue: avatarHue(v.author.login),
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
        const remaining = this.rows().filter((row) => row.id !== r.id)
        this.rows.set(remaining)
        this.toast.success('Version deleted')
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
