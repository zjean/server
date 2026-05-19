import { HttpErrorResponse, HttpHeaders } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { USER_ROLE } from '@sync-in-server/backend/src/applications/users/constants/user'
import type { CreateUserDto, UpdateUserDto } from '@sync-in-server/backend/src/applications/users/dto/create-or-update-user.dto'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { Observable } from 'rxjs'
import { StoreService } from '../../../../store/store.service'
import { AdminService } from '../../../admin/admin.service'
import type { AdminUserModel } from '../../../admin/models/admin-user.model'
import type { GuestUserModel } from '../../../users/models/guest.model'
import { ButtonComponent } from '../../components/button.component'
import { ConfirmDialogService } from '../../components/confirm-dialog.service'
import { ToastService } from '../../components/toast.service'
import { TwoFaDialogService } from '../../components/two-fa-dialog.service'
import { PickedMember, UserGroupPickerComponent } from '../../components/user-group-picker.component'
import { IconV2Component } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'

interface ManagerRef {
  id: number
  name: string
  login?: string
  avatarUrl?: string
}

interface UserDraft {
  id?: number
  login: string
  email: string
  firstName: string
  lastName: string
  password: string
  role: USER_ROLE
  isActive: boolean
  storageQuota: number | null
  managers: ManagerRef[]
}

function emptyDraft(isGuest: boolean): UserDraft {
  return {
    login: '',
    email: '',
    firstName: '',
    lastName: '',
    password: '',
    role: isGuest ? USER_ROLE.GUEST : USER_ROLE.USER,
    isActive: true,
    storageQuota: null,
    managers: []
  }
}

@Component({
  selector: 'app-v2-admin-users',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, FormsModule, IconV2Component, L10nTranslateDirective, L10nTranslatePipe, UserGroupPickerComponent],
  template: `
    <div class="au">
      <header class="au__head">
        <div class="au__title-wrap">
          <h1 class="au__title">{{ (isGuests() ? 'Guests' : 'Users') | translate: locale.language }}</h1>
          <span class="au__count">{{ filtered().length }} / {{ users().length }}</span>
        </div>
        <div class="au__segmented" role="tablist" aria-label="{{ 'Account type' | translate: locale.language }}">
          <button
            type="button"
            role="tab"
            class="au__seg"
            [class.au__seg--active]="!isGuests()"
            [attr.aria-selected]="!isGuests()"
            (click)="setIsGuests(false)"
          >
            {{ 'Users' | translate: locale.language }}
          </button>
          <button
            type="button"
            role="tab"
            class="au__seg"
            [class.au__seg--active]="isGuests()"
            [attr.aria-selected]="isGuests()"
            (click)="setIsGuests(true)"
          >
            {{ 'Guests' | translate: locale.language }}
          </button>
        </div>
        <div class="au__actions">
          <input
            type="text"
            class="au__search"
            [value]="search()"
            (input)="onSearch($event)"
            [placeholder]="(isGuests() ? 'Filter guests…' : 'Filter users…') | translate: locale.language"
          />
          <app-v2-btn kind="ghost" size="sm" icon="refresh" (click)="refresh()">{{ 'Refresh' | translate: locale.language }}</app-v2-btn>
          <app-v2-btn kind="primary" size="sm" icon="plus" (click)="openCreate()">
            {{ (isGuests() ? 'New guest' : 'New user') | translate: locale.language }}
          </app-v2-btn>
        </div>
      </header>

      @if (loading()) {
        <div class="au__state" l10nTranslate>Loading…</div>
      } @else if (errorMessage(); as err) {
        <div class="au__state au__state--error">{{ err | translate: locale.language }}</div>
      } @else if (users().length === 0) {
        <div class="au__state">{{ (isGuests() ? 'No guests yet.' : 'No users yet.') | translate: locale.language }}</div>
      } @else {
        <div class="au-table">
          <div class="au-row au-row--head">
            <span l10nTranslate>Login</span>
            <span l10nTranslate>Full name</span>
            <span l10nTranslate>Email</span>
            <span l10nTranslate>Role</span>
            <span l10nTranslate>Status</span>
            <span></span>
          </div>
          @for (u of filtered(); track u.id) {
            <div class="au-row" [class.au-row--disabled]="!u.isActive">
              <span class="au-row__login">
                {{ u.login }}
                @if (u.isAdmin) {
                  <span class="au-row__chip au-row__chip--admin" l10nTranslate>admin</span>
                }
              </span>
              <span class="au-row__name">{{ u.fullName }}</span>
              <span class="au-row__email">{{ u.email }}</span>
              <span>{{ roleLabel(u.role) }}</span>
              <span>
                @if (u.isActive) {
                  <span class="au-row__chip au-row__chip--active" l10nTranslate>Active</span>
                } @else {
                  <span class="au-row__chip au-row__chip--inactive" l10nTranslate>Disabled</span>
                }
              </span>
              <span class="au-row__actions">
                <button
                  type="button"
                  class="au-row__action"
                  (click)="impersonate(u)"
                  [disabled]="!canImpersonate(u)"
                  [attr.title]="'Sign in as…' | translate: locale.language"
                >
                  <app-v2-icon name="person" [size]="12" />
                </button>
                <button type="button" class="au-row__action" (click)="openEdit(u)" [attr.title]="'Edit' | translate: locale.language">
                  <app-v2-icon name="pencil" [size]="12" />
                </button>
                <button
                  type="button"
                  class="au-row__action au-row__action--danger"
                  (click)="confirmDelete(u)"
                  [attr.title]="'Delete' | translate: locale.language"
                >
                  <app-v2-icon name="trash" [size]="12" />
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
            {{ dialogTitle(d) | translate: locale.language }}
          </div>
          <div class="au-dialog__body">
            <label class="au-field">
              <span l10nTranslate>Login</span>
              <input type="text" [(ngModel)]="d.login" [disabled]="!!d.id" autocomplete="off" />
            </label>
            <label class="au-field">
              <span l10nTranslate>Email</span>
              <input type="email" [(ngModel)]="d.email" autocomplete="off" />
            </label>
            <div class="au-field-row">
              <label class="au-field">
                <span l10nTranslate>First name</span>
                <input type="text" [(ngModel)]="d.firstName" autocomplete="off" />
              </label>
              <label class="au-field">
                <span l10nTranslate>Last name</span>
                <input type="text" [(ngModel)]="d.lastName" autocomplete="off" />
              </label>
            </div>
            <label class="au-field">
              <span>
                {{ (d.id ? 'New password (optional)' : 'Password') | translate: locale.language }}
              </span>
              <input type="password" [(ngModel)]="d.password" autocomplete="new-password" />
            </label>
            <div class="au-field-row">
              <label class="au-field">
                <span l10nTranslate>Role</span>
                <select [(ngModel)]="d.role">
                  <option [ngValue]="USER_ROLE.USER">{{ 'User' | translate: locale.language }}</option>
                  <option [ngValue]="USER_ROLE.ADMINISTRATOR">{{ 'Administrator' | translate: locale.language }}</option>
                </select>
              </label>
              <label class="au-field au-field--check">
                <input type="checkbox" [(ngModel)]="d.isActive" />
                <span l10nTranslate>Account active</span>
              </label>
            </div>
            @if (isGuests()) {
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
              </div>
            }
            @if (dialogError(); as err) {
              <div class="au-dialog__error">{{ err }}</div>
            }
          </div>
          <div class="au-dialog__actions">
            <app-v2-btn kind="ghost" size="sm" (click)="closeDialog()">{{ 'Cancel' | translate: locale.language }}</app-v2-btn>
            <app-v2-btn kind="primary" size="sm" [disabled]="busy() || !canSave()" (click)="save()">
              {{ saveLabel(d) | translate: locale.language }}
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
      .au__segmented {
        display: inline-flex;
        padding: 2px;
        background: var(--si-bg3);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r2);
        gap: 2px;
      }
      .au__seg {
        background: transparent;
        border: none;
        padding: 4px 12px;
        font: inherit;
        font-size: 11.5px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        color: var(--si-fg-faint);
        border-radius: var(--si-r1);
        cursor: pointer;

        &--active {
          background: var(--si-bg1);
          color: var(--si-fg);
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
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
        border-radius: 999px;
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
      .au-row {
        display: grid;
        grid-template-columns: 1.2fr 1.2fr 1.8fr 0.8fr 0.8fr 80px;
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
        }
        &--disabled {
          opacity: 0.55;
        }
      }
      .au-row__login {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-weight: 500;
      }
      .au-row__email {
        color: var(--si-fg-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .au-row__chip {
        display: inline-flex;
        padding: 1px 7px;
        border-radius: 999px;
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: 0.2px;
        text-transform: uppercase;

        &--admin {
          background: var(--si-nav-soft);
          color: var(--si-nav);
        }
        &--active {
          background: var(--si-green-soft, rgba(80, 180, 120, 0.2));
          color: oklch(0.86 0.13 155);
        }
        &--inactive {
          background: var(--si-bg4);
          color: var(--si-fg-faint);
        }
      }
      .au-row__actions {
        display: inline-flex;
        justify-content: flex-end;
        gap: 4px;
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
        &--danger:hover {
          color: var(--si-rose);
        }
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
        width: 460px;
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
      .au-field input[type='email'],
      .au-field input[type='password'],
      .au-field select {
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
        &:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
      }
      .au-field--check {
        flex-direction: row;
        align-items: center;
        gap: 8px;

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
        gap: 10px;
      }
      .au-dialog__error {
        color: var(--si-rose);
        font-size: 12px;
      }
      .au-dialog__actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
    `
  ]
})
export class AdminUsersComponent implements OnInit {
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  protected readonly USER_ROLE = USER_ROLE
  private readonly admin = inject(AdminService)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  private readonly toast = inject(ToastService)
  private readonly confirm = inject(ConfirmDialogService)
  private readonly twoFa = inject(TwoFaDialogService)
  private readonly store = inject(StoreService)

  protected readonly users = signal<AdminUserModel[]>([])
  protected readonly isGuests = signal(false)
  protected readonly loading = signal(true)
  protected readonly errorMessage = signal<string | null>(null)
  protected readonly search = signal('')
  protected readonly dialog = signal<UserDraft | null>(null)
  protected readonly dialogError = signal<string | null>(null)
  protected readonly busy = signal(false)

  protected readonly managerIds = computed(() => this.dialog()?.managers.map((m) => m.id) ?? [])

  protected readonly filtered = computed(() => {
    const q = this.search().toLowerCase().trim()
    const list = this.users()
    if (!q) return list
    return list.filter((u) => u.login?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q) || u.fullName?.toLowerCase().includes(q))
  })

  ngOnInit(): void {
    this.breadcrumbs.setBreadcrumbs([{ label: 'Administration', icon: 'person', route: ['/', V2_PATH, V2_ROUTES.ADMIN] }, { label: 'Users' }])
    this.refresh()
  }

  protected refresh(): void {
    this.loading.set(true)
    this.errorMessage.set(null)
    this.admin.listUsers(this.isGuests()).subscribe({
      next: (users) => {
        this.users.set(users)
        this.loading.set(false)
      },
      error: (e: HttpErrorResponse) => {
        this.errorMessage.set(e.error?.message ?? (this.isGuests() ? 'Failed to load guests' : 'Failed to load users'))
        this.loading.set(false)
      }
    })
  }

  protected setIsGuests(value: boolean): void {
    if (this.isGuests() === value) return
    this.isGuests.set(value)
    this.users.set([])
    this.search.set('')
    this.refresh()
  }

  protected dialogTitle(d: UserDraft): string {
    if (d.id) return this.isGuests() ? 'Edit guest' : 'Edit user'
    return this.isGuests() ? 'New guest' : 'New user'
  }

  protected saveLabel(d: UserDraft): string {
    return d.id ? 'Save' : 'Create'
  }

  protected onSearch(ev: Event): void {
    this.search.set((ev.target as HTMLInputElement).value)
  }

  protected roleLabel(role: USER_ROLE | undefined): string {
    switch (role) {
      case USER_ROLE.ADMINISTRATOR:
        return 'Administrator'
      case USER_ROLE.GUEST:
        return 'Guest'
      case USER_ROLE.LINK:
        return 'Link'
      case USER_ROLE.USER:
      default:
        return 'User'
    }
  }

  protected openCreate(): void {
    this.dialogError.set(null)
    this.dialog.set(emptyDraft(this.isGuests()))
  }

  protected openEdit(u: AdminUserModel): void {
    this.dialogError.set(null)
    const base: UserDraft = {
      id: u.id,
      login: u.login ?? '',
      email: u.email ?? '',
      firstName: u.firstName ?? '',
      lastName: u.lastName ?? '',
      password: '',
      role: u.role ?? (this.isGuests() ? USER_ROLE.GUEST : USER_ROLE.USER),
      isActive: u.isActive ?? true,
      storageQuota: u.storageQuota ?? null,
      managers: []
    }
    this.dialog.set(base)

    // Fetch fresh detail for guests to populate the managers list.
    if (this.isGuests()) {
      this.admin.getUser(u.id, true).subscribe({
        next: (guest: GuestUserModel) => {
          const current = this.dialog()
          if (!current || current.id !== u.id) return
          this.dialog.set({
            ...current,
            managers: (guest.managers ?? []).map((m) => ({
              id: m.id,
              name: m.name,
              login: m.login,
              avatarUrl: m.avatarUrl
            }))
          })
        },
        error: () => {
          // Keep the base dialog open; managers just remain empty.
        }
      })
    }
  }

  protected addManager(picked: PickedMember): void {
    const d = this.dialog()
    if (!d) return
    if (d.managers.some((m) => m.id === picked.id)) return
    this.dialog.set({
      ...d,
      managers: [...d.managers, { id: picked.id, name: picked.name, login: picked.login, avatarUrl: picked.avatarUrl }]
    })
  }

  protected removeManager(id: number): void {
    const d = this.dialog()
    if (!d) return
    this.dialog.set({ ...d, managers: d.managers.filter((m) => m.id !== id) })
  }

  protected closeDialog(): void {
    if (this.busy()) return
    this.dialog.set(null)
    this.dialogError.set(null)
  }

  protected canSave(): boolean {
    const d = this.dialog()
    if (!d) return false
    if (!d.login.trim() || !d.email.trim()) return false
    if (!d.id && d.password.length < 8) return false
    return true
  }

  protected async save(): Promise<void> {
    const d = this.dialog()
    if (!d || !this.canSave()) return
    this.busy.set(true)
    this.dialogError.set(null)
    const twoFa = await this.twoFa.verify(false)
    if (twoFa === false) {
      this.busy.set(false)
      return
    }
    const headers = twoFa ?? new HttpHeaders()
    const isGuest = this.isGuests()
    if (d.id) {
      const dto: UpdateUserDto = {
        login: d.login.trim(),
        email: d.email.trim(),
        firstName: d.firstName.trim(),
        lastName: d.lastName.trim(),
        role: d.role,
        isActive: d.isActive
      }
      if (d.password.trim().length >= 8) dto.password = d.password
      if (isGuest) dto.managers = d.managers.map((m) => m.id)
      const update$: Observable<AdminUserModel | GuestUserModel> = isGuest
        ? this.admin.updateUser(d.id, dto, headers, true)
        : this.admin.updateUser(d.id, dto, headers, false)
      update$.subscribe({
        next: (updated) => this.onSaved(updated as AdminUserModel, d.id!),
        error: (e: HttpErrorResponse) => this.onError(e)
      })
    } else {
      const dto: CreateUserDto = {
        login: d.login.trim(),
        email: d.email.trim(),
        firstName: d.firstName.trim(),
        lastName: d.lastName.trim(),
        password: d.password,
        role: d.role,
        isActive: d.isActive
      }
      if (isGuest) dto.managers = d.managers.map((m) => m.id)
      const create$: Observable<AdminUserModel | GuestUserModel> = isGuest
        ? this.admin.createUser(dto, headers, true)
        : this.admin.createUser(dto, headers, false)
      create$.subscribe({
        next: (created) => this.onSaved(created as AdminUserModel),
        error: (e: HttpErrorResponse) => this.onError(e)
      })
    }
  }

  private onSaved(updated: AdminUserModel, editedId?: number): void {
    this.busy.set(false)
    this.dialog.set(null)
    const isGuest = this.isGuests()
    if (editedId !== undefined) {
      this.users.update((list) => list.map((u) => (u.id === editedId ? updated : u)))
      this.toast.success(isGuest ? 'Guest updated' : 'User updated')
    } else {
      this.users.update((list) => [updated, ...list])
      this.toast.success(isGuest ? 'Guest created' : 'User created')
    }
  }

  private onError(e: HttpErrorResponse): void {
    this.busy.set(false)
    this.dialogError.set(e.error?.message ?? (this.isGuests() ? 'Unable to save guest' : 'Unable to save user'))
  }

  protected canImpersonate(u: AdminUserModel): boolean {
    if (!u.isActive) return false
    const self = this.store.user.getValue()
    return !self || self.id !== u.id
  }

  protected async impersonate(u: AdminUserModel): Promise<void> {
    if (!this.canImpersonate(u)) return
    const twoFa = await this.twoFa.verify(true)
    if (twoFa === false) return
    const headers = twoFa ?? new HttpHeaders()
    this.admin.impersonateUser(u.id, headers).subscribe({
      next: (r) => {
        this.admin.initImpersonateUser(r)
      },
      error: (e: HttpErrorResponse) => {
        this.toast.error(e.error?.message ?? 'Failed to impersonate user')
      }
    })
  }

  protected async confirmDelete(u: AdminUserModel): Promise<void> {
    const isGuest = this.isGuests()
    const ok = await this.confirm.open({
      title: isGuest ? 'Delete guest' : 'Delete user',
      message: 'v2_delete_user',
      messageParams: { login: u.login ?? '' },
      confirmLabel: 'Delete',
      kind: 'danger'
    })
    if (!ok) return
    const twoFa = await this.twoFa.verify(true)
    if (twoFa === false) return
    const headers = twoFa ?? new HttpHeaders()
    this.admin.deleteUser(u.id, { isGuest, deleteSpace: false }, headers).subscribe({
      next: () => {
        this.users.update((list) => list.filter((x) => x.id !== u.id))
        this.toast.success(isGuest ? 'Guest deleted' : 'User deleted')
      },
      error: (e: HttpErrorResponse) => {
        this.toast.error(e.error?.message ?? 'Delete failed')
      }
    })
  }
}
