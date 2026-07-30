import { HttpErrorResponse } from '@angular/common/http'
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  EventEmitter,
  HostListener,
  inject,
  input,
  Output,
  signal,
  untracked
} from '@angular/core'
import { FormsModule } from '@angular/forms'
import { USER_GROUP_ROLE } from '@sync-in-server/backend/src/applications/users/constants/user'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { AdminService } from '../../../admin/admin.service'
import type { MemberModel } from '../../../users/models/member.model'
import { ButtonComponent } from '../../components/button.component'
import { ToastService } from '../../components/toast.service'
import { PickedMember, UserGroupPickerComponent } from '../../components/user-group-picker.component'
import { IconV2Component } from '../../icons/icon-v2.component'

export interface GroupRef {
  id: number
  name: string
}

@Component({
  selector: 'app-v2-admin-group-members',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, FormsModule, IconV2Component, L10nTranslateDirective, L10nTranslatePipe, UserGroupPickerComponent],
  template: `
    @if (group()) {
      <div class="gmd__backdrop" (click)="onClose()"></div>
      <aside class="gmd" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
        <header class="gmd__head">
          <div class="gmd__title-wrap">
            <span class="gmd__eyebrow" l10nTranslate>Members of</span>
            <h2 class="gmd__title">{{ group()!.name }}</h2>
          </div>
          <button type="button" class="gmd__close" (click)="onClose()" [attr.title]="'Close' | translate: locale.language">
            <app-v2-icon name="x" [size]="14" />
          </button>
        </header>

        <div class="gmd__body">
          @if (loading()) {
            <div class="gmd__state" l10nTranslate>Loading…</div>
          } @else if (loadError(); as err) {
            <div class="gmd__state gmd__state--error">{{ err | translate: locale.language }}</div>
          } @else {
            <div class="gmd__counts">
              <span class="gmd__count"
                >{{ members().length }} {{ (members().length === 1 ? 'member' : 'members') | translate: locale.language }}</span
              >
              <span class="gmd__count gmd__count--muted"> {{ managerCount() }} {{ 'manager(s)' | translate: locale.language }} </span>
            </div>
            @if (members().length === 0) {
              <div class="gmd__state" l10nTranslate>No members yet.</div>
            } @else {
              <ul class="gmd__list">
                @for (m of members(); track m.id) {
                  <li class="gmd__row">
                    @if (m.avatarUrl) {
                      <img class="gmd__avatar" [src]="m.avatarUrl" alt="" />
                    } @else {
                      <span class="gmd__glyph">@</span>
                    }
                    <span class="gmd__info">
                      <span class="gmd__name">{{ m.name }}</span>
                      @if (m.description) {
                        <span class="gmd__desc">{{ m.description }}</span>
                      }
                    </span>
                    <select
                      class="gmd__role"
                      [ngModel]="m.groupRole ?? USER_GROUP_ROLE.MEMBER"
                      (ngModelChange)="changeRole(m, $event)"
                      [disabled]="busyIds().includes(m.id)"
                    >
                      <option [ngValue]="USER_GROUP_ROLE.MEMBER">{{ 'Member' | translate: locale.language }}</option>
                      <option [ngValue]="USER_GROUP_ROLE.MANAGER">{{ 'Manager' | translate: locale.language }}</option>
                    </select>
                    <button
                      type="button"
                      class="gmd__remove"
                      (click)="remove(m)"
                      [disabled]="busyIds().includes(m.id)"
                      [attr.title]="'Remove from group' | translate: locale.language"
                    >
                      <app-v2-icon name="x" [size]="12" />
                    </button>
                  </li>
                }
              </ul>
            }
          }
        </div>

        <footer class="gmd__foot">
          <span class="gmd__foot-label" l10nTranslate>Add members</span>
          <app-v2-user-group-picker
            [adminScope]="true"
            [onlyUsers]="true"
            [ignoreUserIds]="memberIds()"
            [placeholder]="'Search users…'"
            (pick)="addMember($event)"
          />
          <div class="gmd__foot-actions">
            <app-v2-btn kind="ghost" size="sm" (click)="onClose()">{{ 'Done' | translate: locale.language }}</app-v2-btn>
          </div>
        </footer>
      </aside>
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }
      .gmd__backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.35);
        z-index: var(--si-z-dialog);
      }
      .gmd {
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        width: 420px;
        max-width: 100vw;
        z-index: calc(var(--si-z-dialog) + 1);
        background: var(--si-bg2);
        border-left: 1px solid var(--si-line);
        box-shadow: -12px 0 28px rgba(0, 0, 0, 0.25);
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      .gmd__head {
        padding: 18px 20px 14px;
        display: flex;
        align-items: flex-start;
        gap: 12px;
        border-bottom: 1px solid var(--si-line);
      }
      .gmd__title-wrap {
        flex: 1 1 auto;
        min-width: 0;
      }
      .gmd__eyebrow {
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 1.1px;
        color: var(--si-fg-faint);
        font-weight: 600;
        font-family: var(--si-display);
      }
      .gmd__title {
        margin: 4px 0 0;
        font-size: 18px;
        font-weight: 700;
        color: var(--si-fg);
        letter-spacing: -0.3px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .gmd__close {
        width: 26px;
        height: 26px;
        border-radius: 6px;
        background: transparent;
        border: none;
        color: var(--si-fg-faint);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;

        &:hover {
          background: var(--si-bg4);
          color: var(--si-fg);
        }
      }
      .gmd__body {
        flex: 1 1 auto;
        overflow-y: auto;
        padding: 14px 20px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        min-height: 0;
      }
      .gmd__state {
        padding: 30px 12px;
        text-align: center;
        font-size: 13px;
        color: var(--si-fg-muted);
        &--error {
          color: var(--si-rose);
        }
      }
      .gmd__counts {
        display: flex;
        gap: 10px;
        font-size: 11px;
        font-family: var(--si-mono);
        color: var(--si-fg-muted);
      }
      .gmd__count--muted {
        color: var(--si-fg-faint);
      }
      .gmd__list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .gmd__row {
        display: grid;
        grid-template-columns: 26px 1fr 120px 24px;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
        background: var(--si-bg3);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r2);
      }
      .gmd__avatar,
      .gmd__glyph {
        width: 26px;
        height: 26px;
        border-radius: 50%;
      }
      .gmd__avatar {
        object-fit: cover;
      }
      .gmd__glyph {
        background: var(--si-bg4);
        color: var(--si-fg-muted);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
      }
      .gmd__info {
        display: flex;
        flex-direction: column;
        gap: 1px;
        min-width: 0;
      }
      .gmd__name {
        font-size: 12.5px;
        color: var(--si-fg);
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .gmd__desc {
        font-size: 11px;
        color: var(--si-fg-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .gmd__role {
        background: var(--si-bg2);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r2);
        padding: 5px 7px;
        color: var(--si-fg);
        font: inherit;
        font-size: 11.5px;

        &:focus {
          outline: none;
          border-color: var(--si-nav);
        }
        &:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
      }
      .gmd__remove {
        width: 24px;
        height: 24px;
        border-radius: 5px;
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
        &:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
      }
      .gmd__foot {
        padding: 14px 20px 18px;
        border-top: 1px solid var(--si-line);
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .gmd__foot-label {
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 1px;
        color: var(--si-fg-faint);
        font-weight: 600;
      }
      .gmd__foot-actions {
        display: flex;
        justify-content: flex-end;
      }
    `
  ]
})
export class AdminGroupMembersComponent {
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  protected readonly USER_GROUP_ROLE = USER_GROUP_ROLE
  private readonly admin = inject(AdminService)
  private readonly toast = inject(ToastService)

  readonly group = input<GroupRef | null>(null)

  @Output() membersChanged = new EventEmitter<number>()
  @Output() dismissed = new EventEmitter<void>()

  protected readonly members = signal<MemberModel[]>([])
  protected readonly loading = signal(false)
  protected readonly loadError = signal<string | null>(null)
  protected readonly busyIds = signal<number[]>([])

  protected readonly memberIds = computed(() => this.members().map((m) => m.id))
  protected readonly managerCount = computed(() => this.members().filter((m) => m.isGroupManager).length)

  constructor() {
    effect(() => {
      const g = this.group()
      untracked(() => {
        this.members.set([])
        this.busyIds.set([])
        this.loadError.set(null)
        if (g) this.load(g)
      })
    })
  }

  @HostListener('window:keydown.escape')
  onEscape(): void {
    if (this.group()) this.onClose()
  }

  protected onClose(): void {
    this.dismissed.emit()
  }

  private load(g: GroupRef): void {
    this.loading.set(true)
    this.admin.browseGroup(g.name, false).subscribe({
      next: (browse) => {
        this.members.set(browse.members ?? [])
        this.loading.set(false)
      },
      error: (e: HttpErrorResponse) => {
        this.loadError.set(e.error?.message ?? 'Failed to load members')
        this.loading.set(false)
      }
    })
  }

  protected changeRole(m: MemberModel, role: USER_GROUP_ROLE): void {
    const g = this.group()
    if (!g) return
    const previous = m.groupRole ?? USER_GROUP_ROLE.MEMBER
    if (previous === role) return
    this.busyIds.update((ids) => [...ids, m.id])
    this.admin.updateUserFromGroup(g.id, m.id, { role }).subscribe({
      next: () => {
        this.members.update((list) =>
          list.map((x) => {
            if (x.id !== m.id) return x
            x.setGroupRole(role)
            return x
          })
        )
        this.busyIds.update((ids) => ids.filter((i) => i !== m.id))
        this.toast.success('Role updated')
      },
      error: (e: HttpErrorResponse) => {
        this.busyIds.update((ids) => ids.filter((i) => i !== m.id))
        this.toast.error(e.error?.message ?? 'Failed to update role')
      }
    })
  }

  protected remove(m: MemberModel): void {
    const g = this.group()
    if (!g) return
    this.busyIds.update((ids) => [...ids, m.id])
    this.admin.removeUserFromGroup(g.id, m.id).subscribe({
      next: () => {
        this.members.update((list) => list.filter((x) => x.id !== m.id))
        this.busyIds.update((ids) => ids.filter((i) => i !== m.id))
        this.toast.success('Member removed')
        this.membersChanged.emit(this.members().length)
      },
      error: (e: HttpErrorResponse) => {
        this.busyIds.update((ids) => ids.filter((i) => i !== m.id))
        this.toast.error(e.error?.message ?? 'Failed to remove member')
      }
    })
  }

  protected addMember(picked: PickedMember): void {
    const g = this.group()
    if (!g) return
    this.admin.addUsersToGroup(g.id, [picked.id]).subscribe({
      next: () => {
        // Refresh the full list so groupRole and avatar/description are canonical.
        this.admin.browseGroup(g.name, false).subscribe({
          next: (browse) => {
            this.members.set(browse.members ?? [])
            this.membersChanged.emit(this.members().length)
          }
        })
        this.toast.success('Member added')
      },
      error: (e: HttpErrorResponse) => {
        this.toast.error(e.error?.message ?? 'Failed to add member')
      }
    })
  }
}
