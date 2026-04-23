import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, effect, HostListener, inject, signal, untracked } from '@angular/core'
import type { FileSpace } from '@sync-in-server/backend/src/applications/files/interfaces/file-space.interface'
import type { ShareProps } from '@sync-in-server/backend/src/applications/shares/interfaces/share-props.interface'
import { MEMBER_TYPE } from '@sync-in-server/backend/src/applications/users/constants/member'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { userAvatarUrl } from '../../users/user.functions'
import {
  createShare,
  deleteShare,
  getShare,
  permissionsToPreset,
  type PermissionPreset,
  presetToPermissions,
  type ShareMemberInput,
  updateShare
} from '../utils/share-crud'
import { ButtonComponent } from './button.component'
import { ShareDialogService } from './share-dialog.service'
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
          {{ (isEdit() ? 'v3_share_edit_title' : 'v3_share_create_title') | translate: locale.language }}
        </div>
        <div class="sd__subject" [attr.title]="subjectName()">{{ subjectName() }}</div>

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
                  <select class="sd__preset" [value]="m.preset" (change)="onPresetChange(m, $event)">
                    <option value="viewer">{{ 'v3_share_preset_viewer' | translate: locale.language }}</option>
                    <option value="editor">{{ 'v3_share_preset_editor' | translate: locale.language }}</option>
                    <option value="manager">{{ 'v3_share_preset_manager' | translate: locale.language }}</option>
                  </select>
                  <button type="button" class="sd__remove" (click)="removeMember(m)" [attr.title]="'Remove' | translate: locale.language">×</button>
                </div>
              }
            </div>
          } @else {
            <div class="sd__empty">{{ 'v3_share_no_recipients' | translate: locale.language }}</div>
          }

          <div class="sd__picker-row">
            <app-v2-user-group-picker
              class="sd__picker"
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
                {{ 'v3_share_revoke' | translate: locale.language }}
              </app-v2-btn>
            }
            <span class="sd__spacer"></span>
            <app-v2-btn kind="ghost" size="sm" (click)="cancel()">
              {{ 'Cancel' | translate: locale.language }}
            </app-v2-btn>
            <app-v2-btn kind="primary" size="sm" [disabled]="!canSave()" (click)="save()">
              {{ (isEdit() ? 'v3_share_save' : 'v3_share_create') | translate: locale.language }}
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
        background: rgba(0, 0, 0, 0.35);
        z-index: 76;
      }
      .sd {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 77;
        width: min(500px, calc(100vw - 24px));
        padding: 18px 20px 16px;
        background: var(--si-bg1);
        border: 1px solid var(--si-border);
        border-radius: 10px;
        box-shadow:
          0 4px 14px rgba(0, 0, 0, 0.12),
          0 18px 40px rgba(0, 0, 0, 0.16);
      }
      .sd__title {
        font-size: 15px;
        font-weight: 600;
        color: var(--si-fg);
        margin-bottom: 2px;
      }
      .sd__subject {
        font-size: 12.5px;
        color: var(--si-fg-muted);
        margin-bottom: 14px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sd__state,
      .sd__empty {
        padding: 20px 0;
        text-align: center;
        color: var(--si-fg-muted);
        font-size: 13px;
      }
      .sd__empty {
        padding: 10px 0 14px;
      }
      .sd__list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-bottom: 12px;
        max-height: 240px;
        overflow-y: auto;
      }
      .sd__member {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
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
        font-size: 12px;
      }
      .sd__member-meta {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
      }
      .sd__member-name {
        font-size: 13px;
        font-weight: 500;
        color: var(--si-fg);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sd__member-desc {
        font-size: 11.5px;
        color: var(--si-fg-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sd__preset {
        font: inherit;
        font-size: 12.5px;
        padding: 5px 8px;
        background: var(--si-bg1);
        color: var(--si-fg);
        border: 1px solid var(--si-border);
        border-radius: 5px;
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
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
      }
      .sd__remove:hover {
        background: var(--si-bg3);
        color: var(--si-fg);
      }
      .sd__picker-row {
        margin-bottom: 10px;
      }
      .sd__error {
        font-size: 11.5px;
        color: var(--si-rose, #c0392b);
        margin-bottom: 10px;
      }
      .sd__actions {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-top: 8px;
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
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  protected readonly pending = this.service.pending

  protected readonly isEdit = computed(() => !!this.pending()?.existingShareId)

  protected readonly subjectName = signal('')
  protected readonly members = signal<RowMember[]>([])
  protected readonly loadingExisting = signal(false)
  protected readonly busy = signal(false)
  protected readonly errorMessage = signal<string | null>(null)

  // Track file context for create, or the loaded share for edit.
  private readonly createCtx = signal<{
    file: Pick<FileSpace, 'id' | 'name' | 'isDir' | 'mime' | 'space'>
    relativePath: string
  } | null>(null)
  private readonly editShare = signal<ShareProps | null>(null)

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
        } else if (p.file) {
          this.subjectName.set(p.file.name)
          this.createCtx.set({ file: p.file, relativePath: p.relativePath ?? p.file.name })
          this.members.set([])
        }
      })
    })
  }

  private loadExisting(shareId: number): void {
    this.loadingExisting.set(true)
    this.errorMessage.set(null)
    getShare(this.http, shareId).subscribe({
      next: (share) => {
        this.editShare.set(share)
        this.subjectName.set(share.name)
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
          this.toast.success('v3_share_updated')
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

    const ctx = this.createCtx()
    if (!ctx || !ctx.file) return
    createShare(this.http, {
      file: ctx.file,
      relativePath: ctx.relativePath,
      ownerId: null,
      members
    }).subscribe({
      next: (share) => {
        this.busy.set(false)
        this.toast.success('v3_share_created')
        this.service.latch({ shareId: share.id })
        this.service.close()
      },
      error: (e: HttpErrorResponse) => {
        this.errorMessage.set(e.error?.message ?? 'Failed to create share')
        this.busy.set(false)
      }
    })
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
        this.toast.success('v3_share_revoked')
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
    const p = this.pending()
    if (p?.file) return !!p.file.isDir
    const existing = this.editShare()
    return !!existing?.file?.isDir
  }

  private resetState(): void {
    this.subjectName.set('')
    this.members.set([])
    this.createCtx.set(null)
    this.editShare.set(null)
    this.loadingExisting.set(false)
    this.busy.set(false)
    this.errorMessage.set(null)
  }
}
