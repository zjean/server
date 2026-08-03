import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, effect, HostListener, inject, signal, untracked } from '@angular/core'
import type { ShareProps } from '@sync-in-server/backend/src/applications/shares/interfaces/share-props.interface'
import { SPACE_OPERATION } from '@sync-in-server/backend/src/applications/spaces/constants/spaces'
import { MEMBER_TYPE } from '@sync-in-server/backend/src/applications/users/constants/member'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { userAvatarUrl } from '../../users/user.functions'
import { SPACES_PERMISSIONS_TEXT } from '../../spaces/spaces.constants'
import { StoreService } from '../../../store/store.service'
import {
  createShare,
  deleteShare,
  getShare,
  permissionsToPreset,
  permissionTokens,
  type PermissionPreset,
  presetToPermissions,
  type ShareMemberInput,
  updateShare
} from '../utils/share-crud'
import { ButtonComponent } from './button.component'
import { ShareDialogFileCtx, ShareDialogService } from './share-dialog.service'
import { ToastService } from './toast.service'
import { UserGroupPickerComponent, type PickedMember } from './user-group-picker.component'

interface RowMember extends ShareMemberInput {
  name: string
  description?: string
  avatarUrl?: string
  preset: PermissionPreset
}

@Component({
  selector: 'app-v2-share-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, L10nTranslatePipe, UserGroupPickerComponent],
  template: `
    @if (pending(); as p) {
      <div class="sd__backdrop" (click)="cancel()"></div>
      <div class="sd" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
        <div class="sd__title">
          {{ (isEdit() ? 'v2_share_edit_title' : 'v2_share_create_title') | translate: locale.language }}
        </div>
        @if (isMulti()) {
          <div class="sd__subject">{{ 'v2_share_n_items_subject' | translate: locale.language : { nb: multiCount() } }}</div>
        } @else {
          <div class="sd__subject" [attr.title]="subjectName()">{{ subjectName() }}</div>
        }

        @if (loadingExisting()) {
          <div class="sd__state">{{ 'Loading…' | translate: locale.language }}</div>
        } @else {
          @if (members().length > 0) {
            <div class="sd__list">
              @for (m of members(); track memberKey(m)) {
                <div class="sd__member">
                  @if (m.avatarUrl) {
                    <img class="sd__avatar" [src]="m.avatarUrl" alt="" />
                  } @else {
                    <span class="sd__glyph">{{ isGroupType(m.type) ? '⚑' : '@' }}</span>
                  }
                  <div class="sd__member-meta">
                    <div class="sd__member-name">{{ m.name }}</div>
                    @if (m.description) {
                      <div class="sd__member-desc">{{ m.description }}</div>
                    }
                  </div>
                  <span class="sd__perm">
                    <select class="sd__preset" [value]="m.preset" (change)="onPresetChange(m, $event)">
                      <option value="viewer">{{ 'v2_share_preset_viewer' | translate: locale.language }}</option>
                      <option value="editor">{{ 'v2_share_preset_editor' | translate: locale.language }}</option>
                      <option value="manager">{{ 'v2_share_preset_manager' | translate: locale.language }}</option>
                    </select>
                    <span class="sd__perm-tip" role="tooltip">
                      @if (permTexts(m.permissions); as texts) {
                        @if (texts.length) {
                          @for (t of texts; track t) {
                            <span class="sd__perm-row">{{ t | translate: locale.language }}</span>
                          }
                        } @else {
                          <span class="sd__perm-row">{{ 'No permissions' | translate: locale.language }}</span>
                        }
                      }
                    </span>
                  </span>
                  <button type="button" class="sd__remove" (click)="removeMember(m)" [attr.title]="'Remove' | translate: locale.language">×</button>
                </div>
              }
            </div>
          } @else {
            <div class="sd__empty">{{ 'v2_share_no_recipients' | translate: locale.language }}</div>
          }

          <div class="sd__picker-row">
            <app-v2-user-group-picker
              class="sd__picker"
              [adminScope]="isAdmin"
              [ignoreUserIds]="ignoredUserIds()"
              [ignoreGroupIds]="ignoredGroupIds()"
              (pick)="onPick($event)"
            />
          </div>

          @if (errorMessage(); as err) {
            <div class="sd__error">{{ err }}</div>
          }

          <div class="sd__actions">
            @if (isEdit()) {
              <app-v2-btn kind="danger" size="sm" icon="trash" [disabled]="busy()" (click)="revoke()">
                {{ 'v2_share_revoke' | translate: locale.language }}
              </app-v2-btn>
            }
            <span class="sd__spacer"></span>
            <app-v2-btn kind="ghost" size="sm" (click)="cancel()">
              {{ 'Cancel' | translate: locale.language }}
            </app-v2-btn>
            <app-v2-btn kind="primary" size="sm" [disabled]="!canSave()" (click)="save()">
              {{ (isEdit() ? 'v2_share_save' : 'v2_share_create') | translate: locale.language }}
            </app-v2-btn>
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }
      .sd__backdrop {
        position: fixed;
        inset: 0;
        background: var(--si-scrim);
        z-index: var(--si-z-dialog);
      }
      .sd {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: calc(var(--si-z-dialog) + 1);
        width: min(500px, calc(100vw - 24px));
        padding: var(--si-space-9) var(--si-space-10) var(--si-space-8);
        background: var(--si-bg1);
        border: 1px solid var(--si-border);
        border-radius: 10px;
        box-shadow: var(--si-shadow3);
      }
      .sd__title {
        font-size: var(--si-text-11);
        font-weight: 600;
        color: var(--si-fg);
        margin-bottom: var(--si-space-1);
      }
      .sd__subject {
        font-size: var(--si-text-7);
        color: var(--si-fg-muted);
        margin-bottom: var(--si-space-7);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sd__state,
      .sd__empty {
        padding: var(--si-space-10) 0;
        text-align: center;
        color: var(--si-fg-muted);
        font-size: var(--si-text-8);
      }
      .sd__empty {
        padding: var(--si-space-5) 0 var(--si-space-7);
      }
      .sd__list {
        display: flex;
        flex-direction: column;
        gap: var(--si-space-3);
        margin-bottom: var(--si-space-6);
        max-height: 240px;
        overflow-y: auto;
      }
      .sd__member {
        display: flex;
        align-items: center;
        gap: var(--si-space-4);
        padding: var(--si-space-4) var(--si-space-5);
        background: var(--si-bg2);
        border: 1px solid var(--si-border);
        border-radius: 6px;
      }
      .sd__avatar {
        width: 26px;
        height: 26px;
        border-radius: 50%;
        object-fit: cover;
      }
      .sd__glyph {
        width: 26px;
        height: 26px;
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: var(--si-bg3);
        color: var(--si-fg-muted);
        font-size: var(--si-text-6);
      }
      .sd__member-meta {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
      }
      .sd__member-name {
        font-size: var(--si-text-8);
        font-weight: 500;
        color: var(--si-fg);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sd__member-desc {
        font-size: var(--si-text-5);
        color: var(--si-fg-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sd__perm {
        position: relative;
        display: inline-flex;
      }
      .sd__preset {
        font: inherit;
        font-size: var(--si-text-7);
        padding: var(--si-space-3) var(--si-space-4);
        background: var(--si-bg1);
        color: var(--si-fg);
        border: 1px solid var(--si-border);
        border-radius: 5px;
      }
      .sd__perm-tip {
        position: absolute;
        bottom: calc(100% + 8px);
        right: 0;
        z-index: var(--si-z-popover);
        display: flex;
        flex-direction: column;
        gap: var(--si-space-1);
        min-width: max-content;
        max-width: 220px;
        padding: var(--si-space-4) var(--si-space-5);
        background: var(--si-bg0);
        color: var(--si-fg);
        border: 1px solid var(--si-border);
        border-radius: var(--si-r1);
        box-shadow: var(--si-shadow2);
        font-size: var(--si-text-6);
        line-height: 1.35;
        text-align: left;
        white-space: nowrap;
        opacity: 0;
        visibility: hidden;
        transform: translateY(2px);
        transition:
          opacity 0.12s ease,
          transform 0.12s ease,
          visibility 0.12s;
        pointer-events: none;
      }
      .sd__perm:hover .sd__perm-tip {
        opacity: 1;
        visibility: visible;
        transform: translateY(0);
      }
      .sd__perm-row {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sd__remove {
        width: 26px;
        height: 26px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        color: var(--si-fg-muted);
        border: none;
        border-radius: 5px;
        font-size: var(--si-text-12);
        line-height: 1;
        cursor: pointer;
      }
      .sd__remove:hover {
        background: var(--si-bg3);
        color: var(--si-fg);
      }
      .sd__picker-row {
        margin-bottom: var(--si-space-5);
      }
      .sd__error {
        font-size: var(--si-text-5);
        color: var(--si-rose-ink);
        margin-bottom: var(--si-space-5);
      }
      .sd__actions {
        display: flex;
        gap: var(--si-space-4);
        align-items: center;
        margin-top: var(--si-space-4);
      }
      .sd__spacer {
        flex: 1;
      }
    `
  ]
})
export class ShareDialogComponent {
  private readonly service = inject(ShareDialogService)
  private readonly http = inject(HttpClient)
  private readonly toast = inject(ToastService)
  private readonly store = inject(StoreService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  protected readonly isAdmin: boolean = this.store.user.getValue()?.isAdmin ?? false

  protected readonly pending = this.service.pending

  protected readonly isEdit = computed(() => !!this.pending()?.existingShareId)

  protected readonly members = signal<RowMember[]>([])
  protected readonly loadingExisting = signal(false)
  protected readonly busy = signal(false)
  protected readonly errorMessage = signal<string | null>(null)

  // Create flow: N file contexts (single entry for single-file shares).
  // Edit flow: the loaded share.
  private readonly createCtxs = signal<ShareDialogFileCtx[]>([])
  private readonly editShare = signal<ShareProps | null>(null)

  protected readonly subjectName = computed(() => {
    const share = this.editShare()
    if (share) return share.name
    const ctxs = this.createCtxs()
    if (ctxs.length === 0) return ''
    if (ctxs.length === 1) return ctxs[0].file.name
    return ''
  })
  protected readonly isMulti = computed(() => !this.isEdit() && this.createCtxs().length > 1)
  protected readonly multiCount = computed(() => this.createCtxs().length)

  protected readonly ignoredUserIds = computed(() =>
    this.members()
      .filter((m) => m.type === MEMBER_TYPE.USER || m.type === MEMBER_TYPE.GUEST)
      .map((m) => m.id)
  )
  protected readonly ignoredGroupIds = computed(() =>
    this.members()
      .filter((m) => this.isGroupType(m.type))
      .map((m) => m.id)
  )

  constructor() {
    effect(() => {
      const p = this.pending()
      untracked(() => {
        if (!p) {
          this.resetState()
          return
        }
        if (p.existingShareId) {
          this.loadExisting(p.existingShareId)
          return
        }
        // Create flow: accept either `files[]` (multi) or the legacy single `file`.
        const ctxs: ShareDialogFileCtx[] = p.files?.length
          ? p.files
          : p.file
            ? [{ file: p.file, relativePath: p.relativePath ?? p.file.name, ownerId: p.ownerId ?? null }]
            : []
        this.createCtxs.set(ctxs)
        this.members.set([])
      })
    })
  }

  private loadExisting(shareId: number): void {
    this.loadingExisting.set(true)
    this.errorMessage.set(null)
    getShare(this.http, shareId).subscribe({
      next: (share) => {
        this.editShare.set(share)
        const rows: RowMember[] = (share.members ?? [])
          // Skip link "members" — link UX lives in link-dialog.
          .filter((m) => !m.linkId)
          .map((m) => ({
            id: m.id,
            type: m.type,
            permissions: m.permissions ?? '',
            name: m.name,
            description: m.description,
            avatarUrl: m.login ? userAvatarUrl(m.login) : undefined,
            preset: permissionsToPreset(m.permissions)
          }))
        this.members.set(rows)
        this.loadingExisting.set(false)
      },
      error: (e: HttpErrorResponse) => {
        this.errorMessage.set(e.error?.message ?? 'Failed to load share')
        this.loadingExisting.set(false)
      }
    })
  }

  protected memberKey(m: RowMember): string {
    return `${m.type}:${m.id}`
  }

  protected isGroupType(t: MEMBER_TYPE): boolean {
    return t === MEMBER_TYPE.GROUP || t === MEMBER_TYPE.PGROUP
  }

  // Groups the granular operations a member's permission string grants into a
  // single hover tooltip on the preset selector — parity with the classic
  // badge-permissions tooltip (upstream dd8647ef). The stored permission string
  // is a `:`-separated list of SPACE_OPERATION tokens (see share-crud.ts),
  // already reflecting the file-vs-dir preset expansion; an empty string means
  // read-only, rendered as "No permissions" like classic. Parsed by token, not
  // by substring — the same way classic's setTextIconPermissions does
  // (spaces/spaces.functions.ts:35).
  private readonly permOrder: SPACE_OPERATION[] = [
    SPACE_OPERATION.ADD,
    SPACE_OPERATION.MODIFY,
    SPACE_OPERATION.DELETE,
    SPACE_OPERATION.SHARE_INSIDE,
    SPACE_OPERATION.SHARE_OUTSIDE
  ]
  protected permTexts(permissions: string): string[] {
    const ops = permissionTokens(permissions)
    return this.permOrder.filter((op) => ops.has(op)).map((op) => SPACES_PERMISSIONS_TEXT[op].text)
  }

  protected onPick(picked: PickedMember): void {
    const isDir = this.pendingFileIsDir()
    const preset: PermissionPreset = 'viewer'
    const row: RowMember = {
      id: picked.id,
      type: picked.type,
      permissions: presetToPermissions(preset, isDir),
      name: picked.name,
      description: picked.description,
      avatarUrl: picked.avatarUrl,
      preset
    }
    this.members.update((list) => [...list, row])
  }

  protected onPresetChange(m: RowMember, ev: Event): void {
    const v = (ev.target as HTMLSelectElement).value as PermissionPreset
    const isDir = this.pendingFileIsDir()
    this.members.update((list) =>
      list.map((x) => (this.memberKey(x) === this.memberKey(m) ? { ...x, preset: v, permissions: presetToPermissions(v, isDir) } : x))
    )
  }

  protected removeMember(m: RowMember): void {
    this.members.update((list) => list.filter((x) => this.memberKey(x) !== this.memberKey(m)))
  }

  protected canSave(): boolean {
    if (this.busy()) return false
    if (this.loadingExisting()) return false
    if (this.members().length === 0) return false
    return true
  }

  protected save(): void {
    const p = this.pending()
    if (!p) return
    this.busy.set(true)
    this.errorMessage.set(null)
    const members: ShareMemberInput[] = this.members().map((m) => ({
      id: m.id,
      type: m.type,
      permissions: m.permissions
    }))

    if (this.isEdit() && p.existingShareId) {
      const shareId = p.existingShareId
      updateShare(this.http, { shareId, members }).subscribe({
        next: () => {
          this.busy.set(false)
          this.toast.success('v2_share_updated')
          this.service.latch({ shareId })
          this.service.close()
        },
        error: (e: HttpErrorResponse) => {
          this.errorMessage.set(e.error?.message ?? 'Failed to save share')
          this.busy.set(false)
        }
      })
      return
    }

    const ctxs = this.createCtxs()
    if (ctxs.length === 0) return
    if (ctxs.length === 1) {
      const ctx = ctxs[0]
      createShare(this.http, {
        file: ctx.file,
        relativePath: ctx.relativePath,
        ownerId: ctx.ownerId,
        members
      }).subscribe({
        next: (share) => {
          this.busy.set(false)
          this.toast.success('v2_share_created')
          this.service.latch({ shareId: share.id })
          this.service.close()
        },
        error: (e: HttpErrorResponse) => {
          this.errorMessage.set(e.error?.message ?? 'Failed to create share')
          this.busy.set(false)
        }
      })
      return
    }

    // Multi-file: fire one createShare per file in parallel. Collect
    // successes + failures for a summary toast; latch the first success so
    // callers that care about "a share was created" still get a shareId.
    let firstShareId: number | null = null
    let created = 0
    let failed = 0
    let completed = 0
    const total = ctxs.length
    for (const ctx of ctxs) {
      createShare(this.http, {
        file: ctx.file,
        relativePath: ctx.relativePath,
        ownerId: ctx.ownerId,
        members
      }).subscribe({
        next: (share) => {
          if (firstShareId === null) firstShareId = share.id
          created += 1
          completed += 1
          if (completed === total) this.finishMulti(firstShareId, created, failed)
        },
        error: () => {
          failed += 1
          completed += 1
          if (completed === total) this.finishMulti(firstShareId, created, failed)
        }
      })
    }
  }

  private finishMulti(firstShareId: number | null, created: number, failed: number): void {
    this.busy.set(false)
    if (created === 0) {
      this.errorMessage.set('Failed to create any share')
      return
    }
    if (failed > 0) {
      this.toast.error('v2_share_n_partial_fail', { created, failed })
    } else if (created === 1) {
      this.toast.success('v2_share_created')
    } else {
      this.toast.success('v2_share_n_created', { nb: created })
    }
    this.service.latch({ shareId: firstShareId ?? 0, multi: { created, failed } })
    this.service.close()
  }

  protected revoke(): void {
    const p = this.pending()
    if (!p?.existingShareId) return
    const shareId = p.existingShareId
    this.busy.set(true)
    this.errorMessage.set(null)
    deleteShare(this.http, shareId).subscribe({
      next: () => {
        this.busy.set(false)
        this.toast.success('v2_share_revoked')
        this.service.latch({ shareId, revoked: true })
        this.service.close()
      },
      error: (e: HttpErrorResponse) => {
        this.errorMessage.set(e.error?.message ?? 'Failed to revoke share')
        this.busy.set(false)
      }
    })
  }

  protected cancel(): void {
    this.service.close()
  }

  @HostListener('window:keydown.escape')
  onEscape(): void {
    if (this.pending()) this.cancel()
  }

  private pendingFileIsDir(): boolean {
    const ctxs = this.createCtxs()
    // Presets hinge on isDir (editor/manager permission strings differ for files vs
    // folders). For a heterogeneous multi-select, we pick the first; classic's
    // share-dialog makes the same choice. Callers can exclude folders if they
    // want file-only permissions.
    if (ctxs.length > 0) return !!ctxs[0].file.isDir
    const existing = this.editShare()
    return !!existing?.file?.isDir
  }

  private resetState(): void {
    this.members.set([])
    this.createCtxs.set([])
    this.editShare.set(null)
    this.loadingExisting.set(false)
    this.busy.set(false)
    this.errorMessage.set(null)
  }
}
