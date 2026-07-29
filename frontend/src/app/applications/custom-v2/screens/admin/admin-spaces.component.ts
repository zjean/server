import { HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core'
import { FormsModule } from '@angular/forms'
import type { CreateOrUpdateSpaceDto, SpaceMemberDto } from '@sync-in-server/backend/src/applications/spaces/dto/create-or-update-space.dto'
import { MEMBER_TYPE } from '@sync-in-server/backend/src/applications/users/constants/member'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { AdminService } from '../../../admin/admin.service'
import type { MemberModel } from '../../../users/models/member.model'
import { SpaceModel } from '../../../spaces/models/space.model'
import { SpacesService } from '../../../spaces/services/spaces.service'
import { AvatarStackComponent, AvatarStackUser } from '../../components/avatar-stack.component'
import { ButtonComponent } from '../../components/button.component'
import { ConfirmDialogService } from '../../components/confirm-dialog.service'
import { ToastService } from '../../components/toast.service'
import { PickedMember, UserGroupPickerComponent } from '../../components/user-group-picker.component'
import { IconV2Component } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { memberAvatars } from '../../utils/member-avatars'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'

interface ManagerRef {
  id: number
  type: MEMBER_TYPE
  name: string
  login?: string
  avatarUrl?: string
}

interface SpaceDraft {
  id?: number
  name: string
  description: string
  enabled: boolean
  storageQuotaGB: number | null
  storageIndexing: boolean
  managers: ManagerRef[]
  original?: SpaceModel
}

const BYTES_PER_GB = 1024 * 1024 * 1024

function emptyDraft(): SpaceDraft {
  return {
    name: '',
    description: '',
    enabled: true,
    storageQuotaGB: null,
    storageIndexing: false,
    managers: []
  }
}

function toManagerRef(m: MemberModel): ManagerRef {
  return {
    id: m.id,
    type: m.type,
    name: m.name,
    login: m.login,
    avatarUrl: m.avatarUrl
  }
}

function quotaToGb(bytes: number | null | undefined): number | null {
  if (!bytes || bytes <= 0) return null
  return Math.round((bytes / BYTES_PER_GB) * 100) / 100
}

function gbToBytes(gb: number | null): number | null {
  if (!gb || gb <= 0) return null
  return Math.round(gb * BYTES_PER_GB)
}

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

function formatAgo(d: Date | string | null | undefined): string {
  if (!d) return ''
  const ms = Date.now() - new Date(d).getTime()
  if (ms < 0) return ''
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(months / 12)}y`
}

type SortColumn = 'name' | 'storage' | 'members' | 'modified'

@Component({
  selector: 'app-v2-admin-spaces',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarStackComponent, ButtonComponent, FormsModule, IconV2Component, L10nTranslateDirective, L10nTranslatePipe, UserGroupPickerComponent],
  template: `
    <div class="au">
      <header class="au__head">
        <div class="au__title-wrap">
          <h1 class="au__title" l10nTranslate>Spaces</h1>
          <span class="au__count">{{ filtered().length }} / {{ spaces().length }}</span>
        </div>
        <div class="au__actions">
          <input
            type="text"
            class="au__search"
            [value]="search()"
            (input)="onSearch($event)"
            [placeholder]="'Filter spaces…' | translate: locale.language"
          />
          <app-v2-btn kind="ghost" size="sm" icon="refresh" (click)="refresh()">{{ 'Refresh' | translate: locale.language }}</app-v2-btn>
          <app-v2-btn kind="primary" size="sm" icon="plus" (click)="openCreate()">
            {{ 'New space' | translate: locale.language }}
          </app-v2-btn>
        </div>
      </header>

      @if (loading()) {
        <div class="au__state" l10nTranslate>Loading…</div>
      } @else if (errorMessage(); as err) {
        <div class="au__state au__state--error">{{ err | translate: locale.language }}</div>
      } @else if (spaces().length === 0) {
        <div class="au__state">{{ 'No spaces yet.' | translate: locale.language }}</div>
      } @else {
        <div class="au-table">
          <div class="as-row as-row--head">
            <span class="as-col-name" (click)="toggleSort('name')">
              <span l10nTranslate>Name</span>
              @if (sortBy() === 'name') {
                <span class="as-sort">{{ sortDir() === 'asc' ? '↑' : '↓' }}</span>
              }
            </span>
            <span class="as-col-desc" l10nTranslate>Description</span>
            <span class="as-col-managers" l10nTranslate>Managers</span>
            <span class="as-col-storage" (click)="toggleSort('storage')">
              <span l10nTranslate>Storage</span>
              @if (sortBy() === 'storage') {
                <span class="as-sort">{{ sortDir() === 'asc' ? '↑' : '↓' }}</span>
              }
            </span>
            <span class="as-col-members" (click)="toggleSort('members')">
              <span l10nTranslate>Members</span>
              @if (sortBy() === 'members') {
                <span class="as-sort">{{ sortDir() === 'asc' ? '↑' : '↓' }}</span>
              }
            </span>
            <span class="as-col-modified" (click)="toggleSort('modified')">
              <span l10nTranslate>Modified</span>
              @if (sortBy() === 'modified') {
                <span class="as-sort">{{ sortDir() === 'asc' ? '↑' : '↓' }}</span>
              }
            </span>
            <span class="as-col-actions"></span>
          </div>
          @for (s of filtered(); track s.id) {
            <div class="as-row" [class.as-row--disabled]="!s.enabled">
              <span class="as-col-name">
                <button type="button" class="as-name-btn" (click)="openEdit(s)">
                  <app-v2-icon name="folder" [size]="14" />
                  <span>{{ s.name }}</span>
                </button>
                @if (!s.enabled) {
                  <span class="au-row__chip au-row__chip--inactive" l10nTranslate>disabled</span>
                }
              </span>
              <span class="as-col-desc">{{ s.description || '—' }}</span>
              <span class="as-col-managers">
                @if (s.managers.length > 0) {
                  <!-- Shared stack component: same rendering as the Spaces cards, and it
                       carries the member-name hover tooltip (#305). Rows sit on --si-bg2,
                       so the ring matches that surface rather than the card default. -->
                  <app-v2-avatar-stack [users]="managerAvatars(s)" [size]="22" [max]="3" [ring]="'var(--si-bg2)'" />
                } @else {
                  <span class="as-muted">—</span>
                }
              </span>
              <span class="as-col-storage">
                <span class="as-storage-text">
                  {{ formatBytes(s.storageUsage) }} / {{ s.storageQuota ? formatBytes(s.storageQuota) : ('unlimited' | translate: locale.language) }}
                </span>
                @if (s.storageQuota) {
                  <span class="as-storage-bar">
                    <span class="as-storage-fill" [style.width.%]="storagePct(s)"></span>
                  </span>
                }
              </span>
              <span class="as-col-members">{{ s.counts?.users ?? 0 }}+{{ s.counts?.groups ?? 0 }}</span>
              <span class="as-col-modified">{{ formatAgo(s.modifiedAt) }}</span>
              <span class="as-col-actions">
                <button type="button" class="au-row__action" (click)="openEdit(s)" [attr.title]="'Edit' | translate: locale.language">
                  <app-v2-icon name="pencil" [size]="12" />
                </button>
              </span>
            </div>
          }
        </div>
      }

      @if (dialog(); as d) {
        <div class="au-dialog__backdrop" (click)="closeDialog()"></div>
        <div class="au-dialog" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <div class="au-dialog__title">
            {{ (d.id ? 'Edit space' : 'New space') | translate: locale.language }}
          </div>
          <div class="au-dialog__body">
            <label class="au-field">
              <span l10nTranslate>Name</span>
              <input type="text" [(ngModel)]="d.name" autocomplete="off" />
            </label>
            <label class="au-field">
              <span l10nTranslate>Description</span>
              <input type="text" [(ngModel)]="d.description" autocomplete="off" />
            </label>
            <div class="au-field-row">
              <label class="au-field">
                <span l10nTranslate>Quota (GB)</span>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  [ngModel]="d.storageQuotaGB"
                  (ngModelChange)="setQuotaGb(d, $event)"
                  [placeholder]="'unlimited' | translate: locale.language"
                />
              </label>
              <label class="au-field au-field--check">
                <input type="checkbox" [(ngModel)]="d.enabled" />
                <span l10nTranslate>Active</span>
              </label>
              <label class="au-field au-field--check">
                <input type="checkbox" [(ngModel)]="d.storageIndexing" />
                <span l10nTranslate>Full-text indexing</span>
              </label>
            </div>
            <div class="au-field">
              <span l10nTranslate>Managers</span>
              @if (d.managers.length > 0) {
                <div class="au-chips">
                  @for (m of d.managers; track m.id) {
                    <span class="au-chip">
                      @if (m.avatarUrl) {
                        <img class="au-chip__avatar" [src]="m.avatarUrl" alt="" />
                      } @else {
                        <span class="au-chip__glyph">@</span>
                      }
                      <span class="au-chip__name">{{ m.name }}</span>
                      <button type="button" class="au-chip__remove" (click)="removeManager(m.id)">
                        <app-v2-icon name="x" [size]="10" />
                      </button>
                    </span>
                  }
                </div>
              }
              <app-v2-user-group-picker
                [adminScope]="true"
                [onlyUsers]="true"
                [ignoreUserIds]="managerIds()"
                [placeholder]="'Search users…'"
                (pick)="addManager($event)"
              />
              @if (d.managers.length === 0) {
                <span class="au-field__hint" l10nTranslate>v2_space_managers_required</span>
              }
            </div>
            @if (dialogError(); as err) {
              <div class="au-dialog__error">{{ err }}</div>
            }
          </div>
          <div class="au-dialog__actions">
            @if (d.id) {
              <app-v2-btn kind="ghost" size="sm" (click)="confirmDelete(d)" [disabled]="busy()">
                {{ 'Delete' | translate: locale.language }}
              </app-v2-btn>
            }
            <span class="au-dialog__spacer"></span>
            <app-v2-btn kind="ghost" size="sm" (click)="closeDialog()">{{ 'Cancel' | translate: locale.language }}</app-v2-btn>
            <app-v2-btn kind="primary" size="sm" [disabled]="busy() || !canSave()" (click)="save()">
              {{ (d.id ? 'Save' : 'Create') | translate: locale.language }}
            </app-v2-btn>
          </div>
        </div>
      }
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
      .au {
        padding: 22px 28px;
        display: flex;
        flex-direction: column;
        gap: 16px;
        min-height: 0;
        flex: 1 1 auto;
      }
      .au__head {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .au__title-wrap {
        display: flex;
        align-items: baseline;
        gap: 8px;
      }
      .au__title {
        margin: 0;
        font-size: 20px;
        font-weight: 700;
        color: var(--si-fg);
        letter-spacing: -0.3px;
        font-family: var(--si-display);
      }
      .au__count {
        font-size: 11px;
        color: var(--si-fg-faint);
        font-family: var(--si-mono);
      }
      .au__actions {
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .au__search {
        width: 220px;
        height: 30px;
        padding: 0 10px;
        background: var(--si-bg3);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r2);
        color: var(--si-fg);
        font-size: 12.5px;
        outline: none;
        &:focus {
          border-color: var(--si-nav);
        }
      }
      .au__state {
        padding: 60px 20px;
        text-align: center;
        font-size: 13px;
        color: var(--si-fg-muted);
        &--error {
          color: var(--si-rose);
        }
      }
      .au-table {
        display: flex;
        flex-direction: column;
        background: var(--si-bg2);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r3);
        overflow: hidden;
      }
      .as-row {
        display: grid;
        grid-template-columns: 1.4fr 1.4fr 1fr 1.4fr 0.7fr 0.6fr 44px;
        gap: 14px;
        padding: 10px 16px;
        align-items: center;
        font-size: 12.5px;
        color: var(--si-fg);
        border-bottom: 1px solid var(--si-line);

        &:last-child {
          border-bottom: none;
        }
        &--head {
          background: var(--si-bg3);
          font-size: 10.5px;
          text-transform: uppercase;
          letter-spacing: 1.1px;
          color: var(--si-fg-faint);
          font-weight: 600;
          font-family: var(--si-display);
          cursor: default;

          & > span:not(.as-col-desc):not(.as-col-managers):not(.as-col-actions) {
            cursor: pointer;
          }
        }
        &--disabled {
          opacity: 0.55;
        }
      }
      .as-col-name {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      .as-name-btn {
        background: transparent;
        border: none;
        padding: 0;
        font: inherit;
        font-size: inherit;
        color: var(--si-fg);
        display: inline-flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        font-weight: 500;
        min-width: 0;

        & > span {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        &:hover {
          color: var(--si-nav);
        }
      }
      .as-col-desc,
      .as-col-modified,
      .as-col-members {
        color: var(--si-fg-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .as-sort {
        margin-left: 4px;
      }
      .as-muted {
        color: var(--si-fg-faint);
      }
      .as-col-storage {
        display: flex;
        flex-direction: column;
        gap: 3px;
        min-width: 0;
      }
      .as-storage-text {
        font-family: var(--si-mono);
        font-size: 11px;
        color: var(--si-fg-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .as-storage-bar {
        height: 4px;
        background: var(--si-bg4);
        border-radius: 2px;
        overflow: hidden;
      }
      .as-storage-fill {
        display: block;
        height: 100%;
        background: var(--si-nav);
        transition: width 200ms ease;
      }
      .au-row__chip {
        display: inline-flex;
        padding: 1px 7px;
        border-radius: var(--si-r4);
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: 0.2px;
        text-transform: uppercase;
        margin-left: 6px;

        &--inactive {
          background: var(--si-bg4);
          color: var(--si-fg-faint);
        }
      }
      .au-row__action {
        width: 22px;
        height: 22px;
        border-radius: 5px;
        background: transparent;
        border: none;
        color: var(--si-fg-faint);
        cursor: pointer;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;

        &:hover {
          background: var(--si-bg4);
          color: var(--si-fg);
        }
      }

      .au-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        margin-bottom: 6px;
      }
      .au-chip {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 3px 4px 3px 3px;
        background: var(--si-bg3);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r4);
        font-size: 11.5px;
        color: var(--si-fg);
      }
      .au-chip__avatar,
      .au-chip__glyph {
        width: 18px;
        height: 18px;
        border-radius: 50%;
      }
      .au-chip__avatar {
        object-fit: cover;
      }
      .au-chip__glyph {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: var(--si-bg4);
        color: var(--si-fg-muted);
        font-size: 10px;
      }
      .au-chip__name {
        max-width: 140px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .au-chip__remove {
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: transparent;
        border: none;
        color: var(--si-fg-faint);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;

        &:hover {
          background: var(--si-bg4);
          color: var(--si-rose);
        }
      }
      .au-field__hint {
        text-transform: none;
        letter-spacing: normal;
        font-size: 11.5px;
        color: var(--si-fg-faint);
        margin-top: 4px;
      }

      .au-dialog__backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.35);
        z-index: 90;
      }
      .au-dialog {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 520px;
        max-height: 80vh;
        overflow: auto;
        z-index: 91;
        background: var(--si-bg2);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r3);
        box-shadow: var(--si-shadow2, 0 16px 32px rgba(0, 0, 0, 0.35));
        padding: 18px 20px;
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .au-dialog__title {
        font-size: 15px;
        font-weight: 600;
        color: var(--si-fg);
        letter-spacing: -0.1px;
      }
      .au-dialog__body {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .au-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        flex: 1 1 auto;
        min-width: 0;
      }
      .au-field > span {
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 1px;
        color: var(--si-fg-faint);
        font-weight: 600;
      }
      .au-field input[type='text'],
      .au-field input[type='number'] {
        background: var(--si-bg3);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r2);
        padding: 7px 9px;
        color: var(--si-fg);
        font: inherit;
        font-size: 12.5px;

        &:focus {
          outline: none;
          border-color: var(--si-nav);
        }
      }
      .au-field--check {
        flex-direction: row;
        align-items: center;
        gap: 8px;
        flex: 0 0 auto;

        & > span {
          text-transform: none;
          font-weight: 500;
          font-size: 12.5px;
          color: var(--si-fg);
          letter-spacing: normal;
        }
      }
      .au-field-row {
        display: flex;
        gap: 14px;
        align-items: flex-end;
      }
      .au-dialog__error {
        color: var(--si-rose);
        font-size: 12px;
      }
      .au-dialog__actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .au-dialog__spacer {
        flex: 1 1 auto;
      }
    `
  ]
})
export class AdminSpacesComponent implements OnInit {
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private readonly admin = inject(AdminService)
  private readonly spacesService = inject(SpacesService)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  private readonly toast = inject(ToastService)
  private readonly confirm = inject(ConfirmDialogService)

  protected readonly spaces = signal<SpaceModel[]>([])
  protected readonly loading = signal(true)
  protected readonly errorMessage = signal<string | null>(null)
  protected readonly search = signal('')
  protected readonly dialog = signal<SpaceDraft | null>(null)
  protected readonly dialogError = signal<string | null>(null)
  protected readonly busy = signal(false)
  protected readonly sortBy = signal<SortColumn>('name')
  protected readonly sortDir = signal<'asc' | 'desc'>('asc')

  protected readonly managerIds = computed(() => this.dialog()?.managers.map((m) => m.id) ?? [])

  protected readonly filtered = computed(() => {
    const q = this.search().toLowerCase().trim()
    const list = this.spaces()
    const matched = q ? list.filter((s) => s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q)) : list
    return this.applySort(matched)
  })

  // template helpers
  protected readonly formatBytes = formatBytes
  protected readonly formatAgo = formatAgo

  ngOnInit(): void {
    this.breadcrumbs.setBreadcrumbs([{ label: 'Administration', icon: 'person', route: ['/', V2_PATH, V2_ROUTES.ADMIN] }, { label: 'Spaces' }])
    this.refresh()
  }

  protected refresh(): void {
    this.loading.set(true)
    this.errorMessage.set(null)
    this.admin.listSpaces().subscribe({
      next: (spaces) => {
        this.spaces.set(spaces)
        this.loading.set(false)
      },
      error: (e: HttpErrorResponse) => {
        this.errorMessage.set(e.error?.message ?? 'Failed to load spaces')
        this.loading.set(false)
      }
    })
  }

  protected onSearch(ev: Event): void {
    this.search.set((ev.target as HTMLInputElement).value)
  }

  protected toggleSort(col: SortColumn): void {
    if (this.sortBy() === col) {
      this.sortDir.set(this.sortDir() === 'asc' ? 'desc' : 'asc')
    } else {
      this.sortBy.set(col)
      this.sortDir.set(col === 'modified' || col === 'storage' ? 'desc' : 'asc')
    }
  }

  // Manager avatars for the row's stack. No [total] here: this table has its own
  // Members column, so the "+N" chip counts managers beyond `max` (the previous
  // inline markup behaved the same way).
  protected managerAvatars(s: SpaceModel): AvatarStackUser[] {
    return memberAvatars(s.managers)
  }

  protected storagePct(s: SpaceModel): number {
    if (!s.storageQuota || s.storageQuota <= 0) return 0
    return Math.min(100, Math.round(((s.storageUsage ?? 0) / s.storageQuota) * 100))
  }

  protected openCreate(): void {
    this.dialogError.set(null)
    this.dialog.set(emptyDraft())
  }

  protected openEdit(s: SpaceModel): void {
    this.dialogError.set(null)
    this.busy.set(true)
    this.spacesService.getSpace(s.id).subscribe({
      next: (full) => {
        this.busy.set(false)
        this.dialog.set({
          id: full.id,
          name: full.name,
          description: full.description ?? '',
          enabled: full.enabled,
          storageQuotaGB: quotaToGb(full.storageQuota),
          storageIndexing: !!full.storageIndexing,
          managers: (full.managers ?? []).map(toManagerRef),
          original: full
        })
      },
      error: (e: HttpErrorResponse) => {
        this.busy.set(false)
        this.toast.error(e.error?.message ?? 'Failed to load space')
      }
    })
  }

  protected addManager(picked: PickedMember): void {
    const d = this.dialog()
    if (!d) return
    if (picked.type !== MEMBER_TYPE.USER) return
    if (d.managers.some((m) => m.id === picked.id)) return
    this.dialog.set({
      ...d,
      managers: [...d.managers, { id: picked.id, type: picked.type, name: picked.name, login: picked.login, avatarUrl: picked.avatarUrl }]
    })
  }

  protected removeManager(id: number): void {
    const d = this.dialog()
    if (!d) return
    this.dialog.set({ ...d, managers: d.managers.filter((m) => m.id !== id) })
  }

  protected setQuotaGb(d: SpaceDraft, v: number | null): void {
    this.dialog.set({ ...d, storageQuotaGB: v ?? null })
  }

  protected closeDialog(): void {
    if (this.busy()) return
    this.dialog.set(null)
    this.dialogError.set(null)
  }

  protected canSave(): boolean {
    const d = this.dialog()
    if (!d) return false
    if (!d.name.trim()) return false
    if (d.managers.length === 0) return false
    return true
  }

  protected save(): void {
    const d = this.dialog()
    if (!d || !this.canSave()) return
    this.busy.set(true)
    this.dialogError.set(null)

    const managerDtos: SpaceMemberDto[] = d.managers.map((m) => ({ id: m.id, type: m.type }))
    const baseDto = {
      name: d.name.trim(),
      description: d.description.trim(),
      enabled: d.enabled,
      storageQuota: gbToBytes(d.storageQuotaGB),
      storageIndexing: d.storageIndexing,
      managers: managerDtos
    }

    if (d.id && d.original) {
      // Preserve existing non-manager members, links, roots so the backend doesn't wipe them.
      const orig = d.original
      const nonManagerMembers: SpaceMemberDto[] = (orig.members ?? []).map((m) => ({
        id: m.id,
        type: m.type,
        permissions: m.permissions
      }))
      const linkMembers: SpaceMemberDto[] = (orig.links ?? []).map((m) => ({
        id: m.id,
        type: m.type,
        permissions: m.permissions,
        linkId: m.linkId
      }))
      const dto: CreateOrUpdateSpaceDto = {
        id: d.id,
        ...baseDto,
        members: nonManagerMembers,
        links: linkMembers,
        roots: (orig.roots ?? []) as any
      }
      this.spacesService.updateSpace(dto).subscribe({
        next: (updated) => this.onSaved(updated, d.id!),
        error: (e: HttpErrorResponse) => this.onError(e)
      })
    } else {
      const dto: CreateOrUpdateSpaceDto = {
        ...baseDto,
        members: [],
        links: [],
        roots: []
      }
      this.spacesService.createSpace(dto).subscribe({
        next: (created) => this.onSaved(created),
        error: (e: HttpErrorResponse) => this.onError(e)
      })
    }
  }

  protected async confirmDelete(d: SpaceDraft): Promise<void> {
    if (!d.id) return
    const ok = await this.confirm.open({
      title: 'Delete space',
      message: 'v2_delete_space',
      messageParams: { name: d.name },
      confirmLabel: 'Delete',
      kind: 'danger'
    })
    if (!ok) return
    const id = d.id
    this.busy.set(true)
    this.spacesService.deleteSpace(id, { deleteNow: true }).subscribe({
      next: () => {
        this.busy.set(false)
        this.dialog.set(null)
        this.spaces.update((list) => list.filter((s) => s.id !== id))
        this.toast.success('Space deleted')
      },
      error: (e: HttpErrorResponse) => {
        this.busy.set(false)
        this.dialogError.set(e.error?.message ?? 'Delete failed')
      }
    })
  }

  private onSaved(updated: SpaceModel | null, editedId?: number): void {
    this.busy.set(false)
    this.dialog.set(null)
    if (editedId !== undefined) {
      if (updated === null) {
        // Current admin removed themselves as manager — refresh the list.
        this.refresh()
      } else {
        this.spaces.update((list) => list.map((s) => (s.id === editedId ? updated : s)))
      }
      this.toast.success('Space updated')
    } else if (updated) {
      this.spaces.update((list) => [updated, ...list])
      this.toast.success('Space created')
    }
  }

  private onError(e: HttpErrorResponse): void {
    this.busy.set(false)
    this.dialogError.set(e.error?.message ?? 'Unable to save space')
  }

  private applySort(list: SpaceModel[]): SpaceModel[] {
    const col = this.sortBy()
    const dir = this.sortDir()
    const mult = dir === 'asc' ? 1 : -1
    const sorted = [...list].sort((a, b) => {
      switch (col) {
        case 'name':
          return a.name.localeCompare(b.name) * mult
        case 'storage':
          return ((a.storageUsage ?? 0) - (b.storageUsage ?? 0)) * mult
        case 'members':
          return ((a.counts?.users ?? 0) + (a.counts?.groups ?? 0) - ((b.counts?.users ?? 0) + (b.counts?.groups ?? 0))) * mult
        case 'modified': {
          const at = a.modifiedAt ? new Date(a.modifiedAt).getTime() : 0
          const bt = b.modifiedAt ? new Date(b.modifiedAt).getTime() : 0
          return (at - bt) * mult
        }
      }
    })
    return sorted
  }
}
