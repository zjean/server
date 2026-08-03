import { HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { FormsModule } from '@angular/forms'
import { ActivatedRoute, Router, UrlSegment } from '@angular/router'
import { GROUP_TYPE } from '@sync-in-server/backend/src/applications/users/constants/group'
import { USER_GROUP_ROLE, USER_PERMISSION, USER_ROLE } from '@sync-in-server/backend/src/applications/users/constants/user'
import type { UserCreateOrUpdateGroupDto } from '@sync-in-server/backend/src/applications/users/dto/create-or-update-group.dto'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { TimeAgoPipe } from '../../../../common/pipes/time-ago.pipe'
import type { GroupBrowseModel } from '../../../users/models/group-browse.model'
import { MemberModel } from '../../../users/models/member.model'
import { UserService } from '../../../users/user.service'
import { ButtonComponent } from '../../components/button.component'
import { ConfirmDialogService } from '../../components/confirm-dialog.service'
import { ToastService } from '../../components/toast.service'
import { PickedMember, UserGroupPickerComponent } from '../../components/user-group-picker.component'
import { IconV2Component } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'
import { type CurrentGroupRef, groupAllowedActions, isCurrentGroupManager } from './group-actions'

interface GroupDraft {
  // 0 means "create", mirroring classic's sentinel: UserGroupDialogComponent seeds
  // a MemberModel with `id: 0` for a new group and branches on `group.id === 0`
  // (user-group-dialog.component.ts:37 and :65). Anything non-zero is an update
  // by id.
  id: number
  name: string
  description: string
}

@Component({
  selector: 'app-v2-groups',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, FormsModule, IconV2Component, L10nTranslateDirective, L10nTranslatePipe, TimeAgoPipe, UserGroupPickerComponent],
  template: `
    <div class="mg">
      <header class="mg__head">
        <div class="mg__title-wrap">
          <h1 class="mg__title">{{ (currentGroup() ? currentGroup()!.name : 'My groups') | translate: locale.language }}</h1>
          <span class="mg__count">{{ filtered().length }} / {{ members().length }}</span>
        </div>
        <div class="mg__actions">
          @if (currentGroup()) {
            <app-v2-btn kind="ghost" size="sm" icon="chevLeft" (click)="goToRoot()">{{ 'My groups' | translate: locale.language }}</app-v2-btn>
          }
          <input
            type="text"
            class="mg__search"
            [value]="search()"
            (input)="onSearch($event)"
            [placeholder]="(currentGroup() ? 'Filter members…' : 'Filter groups…') | translate: locale.language"
          />
          <app-v2-btn kind="ghost" size="sm" icon="refresh" (click)="refresh()">{{ 'Refresh' | translate: locale.language }}</app-v2-btn>
          @if (toolbarActions().addGroup) {
            <app-v2-btn kind="primary" size="sm" icon="plus" (click)="openCreate()">
              {{ 'New personal group' | translate: locale.language }}
            </app-v2-btn>
          }
          @if (toolbarActions().addUsers) {
            <app-v2-btn kind="primary" size="sm" icon="plus" (click)="openAddUsers()">
              {{ 'Add members' | translate: locale.language }}
            </app-v2-btn>
          }
        </div>
      </header>

      @if (currentGroup(); as g) {
        <div class="mg__context">
          <span class="mg__chip">{{ groupTypeLabel(g.type) | translate: locale.language }}</span>
          <span class="mg__chip mg__chip--muted">
            {{ (isCurrentGroupManager() ? 'Manager' : 'Member') | translate: locale.language }}
          </span>
        </div>
      }

      @if (loading()) {
        <div class="mg__state" l10nTranslate>Loading…</div>
      } @else if (errorMessage(); as err) {
        <div class="mg__state mg__state--error">{{ err | translate: locale.language }}</div>
      } @else if (members().length === 0) {
        <div class="mg__state">
          {{ (currentGroup() ? 'No members yet.' : 'You do not belong to any group yet.') | translate: locale.language }}
        </div>
      } @else {
        <div class="mg-table" [class.mg-table--members]="!!currentGroup()">
          <div class="mg-row mg-row--head">
            <span l10nTranslate>Name</span>
            @if (currentGroup()) {
              <span class="mg-row__center" l10nTranslate>Role</span>
              <span class="mg-row__center" l10nTranslate>Member since</span>
            } @else {
              <span class="mg-row__center" l10nTranslate>Type</span>
              <span class="mg-row__center" l10nTranslate>Role</span>
              <span class="mg-row__center" l10nTranslate>Members</span>
              <span class="mg-row__center" l10nTranslate>Created</span>
              <span class="mg-row__center" l10nTranslate>Modified</span>
            }
            <span></span>
          </div>
          @for (m of filtered(); track m.mid) {
            <div
              class="mg-row"
              [class.mg-row--selected]="m.mid === selected()?.mid"
              [class.mg-row--group]="m.isGroup"
              (click)="select(m)"
              (dblclick)="browse(m)"
            >
              <span class="mg-row__name">
                @if (m.isUser) {
                  @if (m.avatarUrl) {
                    <img class="mg-row__avatar" [src]="m.avatarUrl" alt="" />
                  } @else {
                    <span class="mg-row__glyph">&#64;</span>
                  }
                } @else {
                  <span class="mg-row__glyph mg-row__glyph--group" [class.mg-row__glyph--personal]="m.isPersonalGroup">
                    <app-v2-icon name="people" [size]="12" />
                  </span>
                }
                <span class="mg-row__label">
                  <span class="mg-row__title">{{ m.name }}</span>
                  @if (m.description) {
                    <span class="mg-row__desc">{{ m.description }}</span>
                  }
                </span>
              </span>

              @if (currentGroup()) {
                <span class="mg-row__center">{{ memberRoleLabel(m) | translate: locale.language }}</span>
                <span class="mg-row__center mg-row__muted">{{ m.createdAt | amTimeAgo: true }}</span>
              } @else {
                <span class="mg-row__center">{{ m.type | translate: locale.language }}</span>
                <span class="mg-row__center">{{ (m.isGroupManager ? 'Manager' : 'Member') | translate: locale.language }}</span>
                <span class="mg-row__center mg-row__muted">{{ m.counts?.users ?? 0 }}</span>
                <span class="mg-row__center mg-row__muted">{{ m.createdAt | amTimeAgo: true }}</span>
                <span class="mg-row__center mg-row__muted">{{ m.modifiedAt | amTimeAgo: true }}</span>
              }

              <span class="mg-row__actions">
                @if (m.isGroup) {
                  <button
                    type="button"
                    class="mg-row__action"
                    (click)="browse(m); $event.stopPropagation()"
                    [attr.title]="'See members' | translate: locale.language"
                    [attr.aria-label]="'See members' | translate: locale.language"
                  >
                    <app-v2-icon name="people" [size]="12" />
                  </button>
                }
                @if (rowActions(m).editGroup || rowActions(m).editUser) {
                  <button
                    type="button"
                    class="mg-row__action"
                    (click)="openEdit(m); $event.stopPropagation()"
                    [attr.title]="(m.isGroup ? 'Edit group' : 'Edit user') | translate: locale.language"
                    [attr.aria-label]="(m.isGroup ? 'Edit group' : 'Edit user') | translate: locale.language"
                  >
                    <app-v2-icon name="pencil" [size]="12" />
                  </button>
                }
                @if (rowActions(m).leaveGroup) {
                  <button
                    type="button"
                    class="mg-row__action"
                    (click)="confirmLeave(m); $event.stopPropagation()"
                    [attr.title]="'Leave group' | translate: locale.language"
                    [attr.aria-label]="'Leave group' | translate: locale.language"
                  >
                    <app-v2-icon name="arrowUp" [size]="12" />
                  </button>
                }
                @if (rowActions(m).removeGroup || rowActions(m).removeUser) {
                  <button
                    type="button"
                    class="mg-row__action mg-row__action--danger"
                    (click)="confirmRemove(m); $event.stopPropagation()"
                    [attr.title]="(m.isGroup ? 'Delete group' : 'Remove from group') | translate: locale.language"
                    [attr.aria-label]="(m.isGroup ? 'Delete group' : 'Remove from group') | translate: locale.language"
                  >
                    <app-v2-icon name="trash" [size]="12" />
                  </button>
                }
              </span>
            </div>
          }
        </div>
      }

      <!-- Create / edit personal group. One dialog for both, like classic's
           UserGroupDialogComponent; draft.id === 0 means create. -->
      @if (draft(); as d) {
        <div class="mg-dialog__backdrop" (click)="closeDraft()"></div>
        <div class="mg-dialog" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <div class="mg-dialog__title">
            {{ (d.id === 0 ? 'New personal group' : 'Edit group') | translate: locale.language }}
          </div>
          <div class="mg-dialog__body">
            <label class="mg-field">
              <span l10nTranslate>Name</span>
              <input type="text" [(ngModel)]="d.name" autocomplete="off" />
            </label>
            <label class="mg-field">
              <span l10nTranslate>Description</span>
              <input type="text" [(ngModel)]="d.description" autocomplete="off" />
            </label>
            @if (draftError(); as err) {
              <div class="mg-dialog__error">{{ err | translate: locale.language }}</div>
            }
          </div>
          <div class="mg-dialog__actions">
            <app-v2-btn kind="ghost" size="sm" (click)="closeDraft()">{{ 'Cancel' | translate: locale.language }}</app-v2-btn>
            <app-v2-btn kind="primary" size="sm" [disabled]="busy() || !canSaveDraft()" (click)="saveDraft()">
              {{ (d.id === 0 ? 'Create' : 'Save') | translate: locale.language }}
            </app-v2-btn>
          </div>
        </div>
      }

      <!-- Add members. Stages picks then submits them in one PATCH, like classic's
           UserGroupAddUsersDialogComponent. -->
      @if (addUsersOpen()) {
        <div class="mg-dialog__backdrop" (click)="closeAddUsers()"></div>
        <div class="mg-dialog" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <div class="mg-dialog__title">{{ 'Add members' | translate: locale.language }}</div>
          <div class="mg-dialog__body">
            <app-v2-user-group-picker
              [onlyUsers]="true"
              [usersRole]="addUsersRole()"
              [ignoreUserIds]="excludedUserIds()"
              placeholder="Search users…"
              (pick)="stageUser($event)"
            />
            @if (staged().length > 0) {
              <ul class="mg-staged">
                @for (s of staged(); track s.id) {
                  <li class="mg-staged__item">
                    <span class="mg-staged__name">{{ s.name }}</span>
                    @if (s.description) {
                      <span class="mg-staged__desc">{{ s.description }}</span>
                    }
                    <button
                      type="button"
                      class="mg-staged__remove"
                      (click)="unstageUser(s)"
                      [attr.title]="'Remove' | translate: locale.language"
                      [attr.aria-label]="'Remove' | translate: locale.language"
                    >
                      <app-v2-icon name="x" [size]="11" />
                    </button>
                  </li>
                }
              </ul>
            } @else {
              <div class="mg-dialog__hint" l10nTranslate>Search for people to add to this group.</div>
            }
          </div>
          <div class="mg-dialog__actions">
            <app-v2-btn kind="ghost" size="sm" (click)="closeAddUsers()">{{ 'Cancel' | translate: locale.language }}</app-v2-btn>
            <app-v2-btn kind="primary" size="sm" [disabled]="busy() || staged().length === 0" (click)="submitAddUsers()">
              {{ 'Add members' | translate: locale.language }}
            </app-v2-btn>
          </div>
        </div>
      }

      <!-- Member role, personal groups only. Classic's
           UserPersonalGroupEditUserDialogComponent is a single manager toggle. -->
      @if (roleEdit(); as r) {
        <div class="mg-dialog__backdrop" (click)="closeRoleEdit()"></div>
        <div class="mg-dialog" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <div class="mg-dialog__title">{{ 'Edit user' | translate: locale.language }}</div>
          <div class="mg-dialog__body">
            <div class="mg-dialog__hint">{{ r.member.name }}</div>
            <label class="mg-field">
              <span l10nTranslate>Role</span>
              <select [ngModel]="r.isManager" (ngModelChange)="setRoleDraft($event)">
                <option [ngValue]="false">{{ 'Member' | translate: locale.language }}</option>
                <option [ngValue]="true">{{ 'Manager' | translate: locale.language }}</option>
              </select>
            </label>
          </div>
          <div class="mg-dialog__actions">
            <app-v2-btn kind="ghost" size="sm" (click)="closeRoleEdit()">{{ 'Cancel' | translate: locale.language }}</app-v2-btn>
            <app-v2-btn kind="primary" size="sm" [disabled]="busy()" (click)="saveRoleEdit()">
              {{ 'Save' | translate: locale.language }}
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
      .mg {
        padding: 22px var(--si-space-12);
        display: flex;
        flex-direction: column;
        gap: var(--si-space-8);
        min-height: 0;
        flex: 1 1 auto;
      }
      .mg__head {
        display: flex;
        align-items: center;
        gap: var(--si-space-6);
        flex-wrap: wrap;
      }
      .mg__title-wrap {
        display: flex;
        align-items: baseline;
        gap: var(--si-space-4);
      }
      .mg__title {
        margin: 0;
        font-family: var(--si-display);
        font-size: var(--si-text-15);
        font-weight: 500;
        color: var(--si-fg);
        letter-spacing: -0.018em;
        line-height: 1.15;
      }
      .mg__count {
        font-size: var(--si-text-4);
        color: var(--si-fg-muted);
        font-family: var(--si-mono);
      }
      .mg__actions {
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: var(--si-space-4);
      }
      .mg__search {
        width: 200px;
        height: 30px;
        padding: 0 var(--si-space-5);
        background: var(--si-bg3);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r2);
        color: var(--si-fg);
        font-size: var(--si-text-7);
        outline: none;
        &:focus {
          border-color: var(--si-nav);
        }
      }
      .mg__context {
        display: flex;
        gap: var(--si-space-3);
        margin-top: calc(-1 * var(--si-space-5));
      }
      .mg__chip {
        font-size: var(--si-text-3);
        text-transform: uppercase;
        letter-spacing: 1px;
        font-weight: 600;
        padding: var(--si-space-1) var(--si-space-4);
        border-radius: var(--si-r1);
        background: var(--si-bg3);
        border: 1px solid var(--si-line);
        color: var(--si-fg-muted);
        &--muted {
          color: var(--si-fg-muted);
        }
      }
      .mg__state {
        padding: 60px var(--si-space-10);
        text-align: center;
        font-size: var(--si-text-8);
        color: var(--si-fg-muted);
        &--error {
          color: var(--si-rose);
        }
      }
      .mg-table {
        display: flex;
        flex-direction: column;
        background: var(--si-bg2);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r3);
        overflow: hidden;
      }
      .mg-row {
        display: grid;
        grid-template-columns: 2.4fr 1fr 0.9fr 0.8fr 1fr 1fr 104px;
        gap: var(--si-space-6);
        padding: var(--si-space-5) var(--si-space-8);
        align-items: center;
        font-size: var(--si-text-7);
        color: var(--si-fg);
        border-bottom: 1px solid var(--si-line);

        &:last-child {
          border-bottom: none;
        }
        &--head {
          background: var(--si-bg3);
          font-size: var(--si-text-3);
          text-transform: uppercase;
          letter-spacing: 1.1px;
          color: var(--si-fg-muted);
          font-weight: 600;
          font-family: var(--si-display);
        }
        &--group {
          cursor: pointer;
        }
        &--selected {
          background: color-mix(in srgb, var(--si-nav) 12%, transparent);
        }
      }
      .mg-table--members .mg-row {
        grid-template-columns: 2.4fr 1fr 1fr 104px;
      }
      .mg-row__center {
        text-align: center;
      }
      .mg-row__muted {
        color: var(--si-fg-muted);
        font-family: var(--si-mono);
        font-size: var(--si-text-5);
      }
      .mg-row__name {
        display: inline-flex;
        align-items: center;
        gap: var(--si-space-5);
        min-width: 0;
      }
      .mg-row__avatar,
      .mg-row__glyph {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        flex: 0 0 auto;
      }
      .mg-row__avatar {
        object-fit: cover;
      }
      .mg-row__glyph {
        background: var(--si-bg3);
        color: var(--si-fg-muted);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: var(--si-text-4);

        &--group {
          color: var(--si-accent-ink);
        }
        &--personal {
          color: var(--si-violet);
        }
      }
      .mg-row__label {
        display: flex;
        flex-direction: column;
        gap: 1px;
        min-width: 0;
      }
      .mg-row__title {
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .mg-row__desc {
        font-size: var(--si-text-4);
        color: var(--si-fg-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .mg-row__actions {
        display: inline-flex;
        justify-content: flex-end;
        gap: var(--si-space-2);
      }
      .mg-row__action {
        width: 24px;
        height: 24px;
        border-radius: 5px;
        background: transparent;
        border: none;
        color: var(--si-fg-muted);
        cursor: pointer;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;

        &:hover {
          background: var(--si-bg3);
          color: var(--si-fg);
        }
        &--danger:hover {
          color: var(--si-rose);
        }
      }

      .mg-dialog__backdrop {
        position: fixed;
        inset: 0;
        background: var(--si-scrim);
        z-index: var(--si-z-dialog);
      }
      .mg-dialog {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 440px;
        max-width: calc(100vw - 32px);
        max-height: 80vh;
        overflow: visible;
        z-index: calc(var(--si-z-dialog) + 1);
        background: var(--si-bg2);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r3);
        box-shadow: var(--si-shadow2);
        padding: var(--si-space-9) var(--si-space-10);
        display: flex;
        flex-direction: column;
        gap: var(--si-space-7);
      }
      .mg-dialog__title {
        font-size: var(--si-text-11);
        font-weight: 600;
        color: var(--si-fg);
      }
      .mg-dialog__body {
        display: flex;
        flex-direction: column;
        gap: var(--si-space-5);
      }
      .mg-dialog__hint {
        font-size: var(--si-text-6);
        color: var(--si-fg-muted);
      }
      .mg-dialog__error {
        color: var(--si-rose);
        font-size: var(--si-text-6);
      }
      .mg-dialog__actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--si-space-4);
      }
      .mg-field {
        display: flex;
        flex-direction: column;
        gap: var(--si-space-2);
      }
      .mg-field > span {
        font-size: var(--si-text-3);
        text-transform: uppercase;
        letter-spacing: 1px;
        color: var(--si-fg-muted);
        font-weight: 600;
      }
      .mg-field input[type='text'],
      .mg-field select {
        background: var(--si-bg3);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r2);
        padding: var(--si-space-4) 9px;
        color: var(--si-fg);
        font: inherit;
        font-size: var(--si-text-7);

        &:focus {
          outline: none;
          border-color: var(--si-nav);
        }
      }
      .mg-staged {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--si-space-2);
      }
      .mg-staged__item {
        display: flex;
        align-items: center;
        gap: var(--si-space-4);
        padding: var(--si-space-3) var(--si-space-5);
        background: var(--si-bg3);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r2);
        font-size: var(--si-text-7);
      }
      .mg-staged__name {
        font-weight: 500;
      }
      .mg-staged__desc {
        color: var(--si-fg-muted);
        font-size: var(--si-text-5);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .mg-staged__remove {
        margin-left: auto;
        width: 20px;
        height: 20px;
        border-radius: 4px;
        background: transparent;
        border: none;
        color: var(--si-fg-muted);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;

        &:hover {
          background: var(--si-bg3);
          color: var(--si-rose);
        }
      }
    `
  ]
})
export class GroupsComponent implements OnInit {
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private readonly route = inject(ActivatedRoute)
  private readonly router = inject(Router)
  private readonly destroyRef = inject(DestroyRef)
  private readonly userService = inject(UserService)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  private readonly toast = inject(ToastService)
  private readonly confirm = inject(ConfirmDialogService)

  protected readonly members = signal<MemberModel[]>([])
  protected readonly currentGroup = signal<CurrentGroupRef | null>(null)
  protected readonly loading = signal(true)
  protected readonly errorMessage = signal<string | null>(null)
  protected readonly search = signal('')
  protected readonly selected = signal<MemberModel | null>(null)
  protected readonly busy = signal(false)

  protected readonly draft = signal<GroupDraft | null>(null)
  protected readonly draftError = signal<string | null>(null)
  protected readonly addUsersOpen = signal(false)
  protected readonly staged = signal<PickedMember[]>([])
  protected readonly roleEdit = signal<{ member: MemberModel; isManager: boolean } | null>(null)

  // Same call classic makes (user-groups.component.ts:172). Read once: the
  // permission cannot change inside a page lifetime.
  private readonly canCreatePersonalGroup = this.userService.userHavePermission(USER_PERMISSION.PERSONAL_GROUPS_ADMIN)

  protected readonly isCurrentGroupManager = computed(() => isCurrentGroupManager(this.currentGroup()))

  /** Toolbar gates — classic's `!this.selected` branch. */
  protected readonly toolbarActions = computed(() => groupAllowedActions(this.currentGroup(), null, this.canCreatePersonalGroup))

  protected readonly filtered = computed(() => {
    const q = this.search().toLowerCase().trim()
    const list = this.members()
    if (!q) return list
    return list.filter((m) => m.name.toLowerCase().includes(q) || (m.description ?? '').toLowerCase().includes(q))
  })

  // Users already in this group, so the picker cannot offer them again — classic
  // passes `currentMemberIds` plus the not-yet-submitted picks for the same reason
  // (user-groups.component.ts:319, user-group-add-users-dialog.component.ts:36).
  protected readonly excludedUserIds = computed(() => [
    ...this.members()
      .filter((m) => m.isUser)
      .map((m) => m.id),
    ...this.staged().map((s) => s.id)
  ])

  // A regular group must not gain guests; a personal group may hold any role.
  protected readonly addUsersRole = computed(() => (this.currentGroup()?.type === GROUP_TYPE.USER ? USER_ROLE.USER : undefined))

  ngOnInit(): void {
    // One '**' route entry serves both levels (see v2.routes.ts), so the level is
    // read off the child's url segments rather than from two components. Classic
    // does the same with its routeResolver: the LAST segment is the group name
    // (user-groups.component.ts:200).
    this.route.url.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((segments: UrlSegment[]) => {
      const name = segments.length ? segments[segments.length - 1].path : undefined
      this.load(name)
    })
  }

  protected refresh(): void {
    this.load(this.currentGroup()?.name)
  }

  protected goToRoot(): void {
    this.router.navigate(['/', V2_PATH, V2_ROUTES.GROUPS]).catch(console.error)
  }

  protected browse(m: MemberModel): void {
    // Classic only navigates for groups (:250-254); a user row is a leaf.
    if (!m.isGroup) return
    this.router.navigate(['/', V2_PATH, V2_ROUTES.GROUPS, m.name]).catch(console.error)
  }

  protected select(m: MemberModel): void {
    this.selected.set(m.mid === this.selected()?.mid ? null : m)
  }

  protected onSearch(ev: Event): void {
    this.search.set((ev.target as HTMLInputElement).value)
  }

  /** Per-row gates — classic's `this.selected` branch, evaluated per row. */
  protected rowActions(m: MemberModel) {
    return groupAllowedActions(this.currentGroup(), m, this.canCreatePersonalGroup)
  }

  protected groupTypeLabel(type: GROUP_TYPE): string {
    return type === GROUP_TYPE.PERSONAL ? 'personal group' : 'group'
  }

  protected memberRoleLabel(m: MemberModel): string {
    if (m.isGroupManager) return 'Manager'
    if (m.isGuest) return 'Guest'
    return 'Member'
  }

  private load(groupName?: string): void {
    this.loading.set(true)
    this.errorMessage.set(null)
    this.selected.set(null)
    this.closeAllDialogs()
    this.userService.browseGroup(groupName).subscribe({
      next: (browse: GroupBrowseModel) => {
        this.currentGroup.set(browse.parentGroup ?? null)
        this.members.set(this.sorted(browse.members ?? []))
        this.setBreadcrumbs()
        this.loading.set(false)
      },
      error: (e: HttpErrorResponse) => {
        this.members.set([])
        this.currentGroup.set(null)
        this.errorMessage.set(e.error?.message ?? 'Failed to load groups')
        this.setBreadcrumbs()
        this.loading.set(false)
      }
    })
  }

  private setBreadcrumbs(): void {
    const g = this.currentGroup()
    const root = { label: 'My groups', icon: 'people' as const, route: ['/', V2_PATH, V2_ROUTES.GROUPS] }
    this.breadcrumbs.setBreadcrumbs(g ? [root, { label: g.name }] : [root])
  }

  // Classic sorts by name by default (SortSettings.default, :174).
  private sorted(list: MemberModel[]): MemberModel[] {
    return [...list].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
  }

  // ---- create / edit group -------------------------------------------------

  protected openCreate(): void {
    this.draftError.set(null)
    this.draft.set({ id: 0, name: '', description: '' })
  }

  protected openEdit(m: MemberModel): void {
    if (m.isUser) {
      this.roleEdit.set({ member: m, isManager: m.isGroupManager })
      return
    }
    this.draftError.set(null)
    this.draft.set({ id: m.id, name: m.name ?? '', description: m.description ?? '' })
  }

  protected closeDraft(): void {
    if (this.busy()) return
    this.draft.set(null)
    this.draftError.set(null)
  }

  protected canSaveDraft(): boolean {
    const d = this.draft()
    return !!d && d.name.trim().length > 0
  }

  protected saveDraft(): void {
    const d = this.draft()
    if (!d || !this.canSaveDraft()) return
    this.busy.set(true)
    this.draftError.set(null)
    if (d.id === 0) {
      this.userService.createPersonalGroup({ name: d.name.trim(), description: d.description.trim() }).subscribe({
        next: (g: MemberModel) => this.onCreated(g),
        error: (e: HttpErrorResponse) => this.onDraftError(e)
      })
      return
    }
    // Classic sends ONLY the changed fields and skips the request entirely when
    // nothing changed (user-group-dialog.component.ts:78-100). The name field is
    // @MinLength(1) but @IsOptional, so an unchanged name must be omitted rather
    // than resent.
    const original = this.members().find((m) => m.id === d.id && m.isGroup)
    const dto: UserCreateOrUpdateGroupDto = {
      name: d.name.trim() !== original?.name ? d.name.trim() : undefined,
      description: d.description.trim() !== (original?.description ?? '') ? d.description.trim() : undefined
    }
    if (dto.name === undefined && dto.description === undefined) {
      this.busy.set(false)
      this.draft.set(null)
      return
    }
    this.userService.updatePersonalGroup(d.id, dto).subscribe({
      next: (g: MemberModel) => this.onUpdated(d.id, g),
      error: (e: HttpErrorResponse) => this.onDraftError(e)
    })
  }

  // Classic does NOT refetch after a create: the POST response carries no role or
  // counts, so it fills both in optimistically — the creator is by definition the
  // group's only member and its manager — and splices the row into the sorted list
  // (user-groups.component.ts:305-310).
  private onCreated(g: MemberModel): void {
    this.busy.set(false)
    this.draft.set(null)
    g.setGroupRole(USER_GROUP_ROLE.MANAGER)
    g.counts = { users: 1 }
    this.members.update((list) => this.sorted([...list, g]))
    this.selected.set(g)
    this.toast.success('Group created')
  }

  private onUpdated(id: number, g: MemberModel): void {
    this.busy.set(false)
    this.draft.set(null)
    this.members.update((list) =>
      this.sorted(
        list.map((m) => {
          if (m.id !== id || !m.isGroup) return m
          // Mutate in place like classic (:356) so the row keeps its derived
          // fields (mid, isPersonalGroup, groupRole) — the PUT response is a bare
          // group, not a membership row.
          return Object.assign(m, { name: g.name, description: g.description, modifiedAt: g.modifiedAt })
        })
      )
    )
    this.toast.success('Group updated')
  }

  private onDraftError(e: HttpErrorResponse): void {
    this.busy.set(false)
    this.draftError.set(e.error?.message ?? 'Unable to save group')
  }

  // ---- add members --------------------------------------------------------

  protected openAddUsers(): void {
    this.staged.set([])
    this.addUsersOpen.set(true)
  }

  protected closeAddUsers(): void {
    if (this.busy()) return
    this.addUsersOpen.set(false)
    this.staged.set([])
  }

  protected stageUser(picked: PickedMember): void {
    if (this.staged().some((s) => s.id === picked.id)) return
    this.staged.update((list) => [...list, picked])
  }

  protected unstageUser(picked: PickedMember): void {
    this.staged.update((list) => list.filter((s) => s.id !== picked.id))
  }

  protected submitAddUsers(): void {
    const g = this.currentGroup()
    const ids = this.staged().map((s) => s.id)
    if (!g || ids.length === 0) return
    this.busy.set(true)
    // PATCH /users/me/groups/:id/users with a BARE array of ids as the body —
    // not an object wrapper (users.controller.ts:141).
    this.userService.addUsersToGroup(g.id, ids).subscribe({
      next: () => {
        this.busy.set(false)
        this.addUsersOpen.set(false)
        this.staged.set([])
        this.toast.success('Member added')
        // Refetch: the PATCH returns void, and each new row needs its groupRole,
        // avatar and description from the browse endpoint. Classic refreshes too.
        this.load(g.name)
      },
      error: (e: HttpErrorResponse) => {
        this.busy.set(false)
        this.toast.error(e.error?.message ?? 'Failed to add member')
      }
    })
  }

  // ---- member role (personal groups only) ---------------------------------

  protected setRoleDraft(isManager: boolean): void {
    this.roleEdit.update((r) => (r ? { ...r, isManager } : r))
  }

  protected closeRoleEdit(): void {
    if (this.busy()) return
    this.roleEdit.set(null)
  }

  protected saveRoleEdit(): void {
    const r = this.roleEdit()
    const g = this.currentGroup()
    if (!r || !g) return
    // Classic short-circuits when the role is unchanged (:34).
    if (r.member.isGroupManager === r.isManager) {
      this.roleEdit.set(null)
      return
    }
    const role = r.isManager ? USER_GROUP_ROLE.MANAGER : USER_GROUP_ROLE.MEMBER
    this.busy.set(true)
    this.userService.updateUserFromPersonalGroup(g.id, r.member.id, { role }).subscribe({
      next: () => {
        this.busy.set(false)
        this.roleEdit.set(null)
        this.members.update((list) =>
          list.map((m) => {
            if (m.id !== r.member.id || !m.isUser) return m
            m.setGroupRole(role)
            return m
          })
        )
        this.toast.success('Role updated')
      },
      error: (e: HttpErrorResponse) => {
        this.busy.set(false)
        this.toast.error(e.error?.message ?? 'Failed to update role')
      }
    })
  }

  // ---- remove / leave -----------------------------------------------------

  protected async confirmRemove(m: MemberModel): Promise<void> {
    const g = this.currentGroup()
    // Classic's single delete dialog branches on the member, not the level
    // (user-group-delete-dialog.component.ts:29-32).
    if (m.isUser) {
      if (!g) return
      const ok = await this.confirm.open({
        title: 'Remove from group',
        message: 'v2_remove_from_group',
        messageParams: { name: m.name, group: g.name },
        confirmLabel: 'Remove',
        kind: 'danger'
      })
      if (!ok) return
      this.userService.removeUserFromGroup(g.id, m.id).subscribe({
        next: () => this.dropRow(m, 'Member removed'),
        error: (e: HttpErrorResponse) => this.toast.error(e.error?.message ?? 'Failed to remove member')
      })
      return
    }
    const ok = await this.confirm.open({
      title: 'Delete group',
      message: 'v2_delete_group',
      messageParams: { name: m.name },
      confirmLabel: 'Delete',
      kind: 'danger'
    })
    if (!ok) return
    this.userService.deletePersonalGroup(m.id).subscribe({
      next: () => this.dropRow(m, 'Group deleted'),
      error: (e: HttpErrorResponse) => this.toast.error(e.error?.message ?? 'Delete failed')
    })
  }

  protected async confirmLeave(m: MemberModel): Promise<void> {
    const ok = await this.confirm.open({
      title: 'Leave group',
      message: 'v2_leave_group',
      messageParams: { name: m.name },
      confirmLabel: 'Leave group',
      kind: 'danger'
    })
    if (!ok) return
    // DELETE /users/me/groups/leave/:id — a DIFFERENT route from the group delete
    // above (API_USERS_MY_GROUPS_LEAVE). Leaving keeps the group; deleting does not.
    this.userService.leavePersonalGroup(m.id).subscribe({
      next: () => this.dropRow(m, 'The group was left'),
      error: (e: HttpErrorResponse) => this.toast.error(e.error?.message ?? 'The group was not left')
    })
  }

  // Classic splices the row out rather than refetching (:340-346, :379-385).
  private dropRow(m: MemberModel, message: string): void {
    this.members.update((list) => list.filter((x) => x.mid !== m.mid))
    if (this.selected()?.mid === m.mid) this.selected.set(null)
    this.toast.success(message)
  }

  private closeAllDialogs(): void {
    this.draft.set(null)
    this.draftError.set(null)
    this.addUsersOpen.set(false)
    this.staged.set([])
    this.roleEdit.set(null)
  }
}
