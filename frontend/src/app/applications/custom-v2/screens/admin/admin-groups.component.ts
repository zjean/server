import { HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { GROUP_VISIBILITY } from '@sync-in-server/backend/src/applications/users/constants/group'
import type { CreateOrUpdateGroupDto } from '@sync-in-server/backend/src/applications/users/dto/create-or-update-group.dto'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { AdminService } from '../../../admin/admin.service'
import type { AdminGroupModel } from '../../../admin/models/admin-group.model'
import type { GroupBrowseModel } from '../../../users/models/group-browse.model'
import { ButtonComponent } from '../../components/button.component'
import { ConfirmDialogService } from '../../components/confirm-dialog.service'
import { ToastService } from '../../components/toast.service'
import { IconV2Component } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'
import { AdminGroupMembersComponent, GroupRef } from './admin-group-members.component'

interface GroupRow {
  id: number
  name: string
  description?: string | null
  visibility: GROUP_VISIBILITY
  memberCount?: number
}

interface GroupDraft {
  id?: number
  name: string
  description: string
  visibility: GROUP_VISIBILITY
}

function emptyDraft(): GroupDraft {
  return { name: '', description: '', visibility: GROUP_VISIBILITY.VISIBLE }
}

@Component({
  selector: 'app-v2-admin-groups',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AdminGroupMembersComponent, ButtonComponent, FormsModule, IconV2Component, L10nTranslateDirective, L10nTranslatePipe],
  template: `
    <div class="ag">
      <header class="ag__head">
        <div class="ag__title-wrap">
          <h1 class="ag__title">{{ (isPersonal() ? 'Personal groups' : 'Groups') | translate: locale.language }}</h1>
          <span class="ag__count">{{ filtered().length }} / {{ groups().length }}</span>
        </div>
        <div class="ag__segmented" role="tablist" aria-label="{{ 'Group scope' | translate: locale.language }}">
          <button
            type="button"
            role="tab"
            class="ag__seg"
            [class.ag__seg--active]="!isPersonal()"
            [attr.aria-selected]="!isPersonal()"
            (click)="setIsPersonal(false)"
          >
            {{ 'Groups' | translate: locale.language }}
          </button>
          <button
            type="button"
            role="tab"
            class="ag__seg"
            [class.ag__seg--active]="isPersonal()"
            [attr.aria-selected]="isPersonal()"
            (click)="setIsPersonal(true)"
          >
            {{ 'Personal' | translate: locale.language }}
          </button>
        </div>
        <div class="ag__actions">
          <input
            type="text"
            class="ag__search"
            [value]="search()"
            (input)="onSearch($event)"
            [placeholder]="'Filter groups…' | translate: locale.language"
          />
          <app-v2-btn kind="ghost" size="sm" icon="refresh" (click)="refresh()">{{ 'Refresh' | translate: locale.language }}</app-v2-btn>
          @if (!isPersonal()) {
            <app-v2-btn kind="primary" size="sm" icon="plus" (click)="openCreate()">{{ 'New group' | translate: locale.language }}</app-v2-btn>
          }
        </div>
      </header>

      @if (loading()) {
        <div class="ag__state" l10nTranslate>Loading…</div>
      } @else if (errorMessage(); as err) {
        <div class="ag__state ag__state--error">{{ err | translate: locale.language }}</div>
      } @else if (groups().length === 0) {
        <div class="ag__state">{{ (isPersonal() ? 'No personal groups.' : 'No groups yet.') | translate: locale.language }}</div>
      } @else {
        <div class="ag-table">
          <div class="ag-row ag-row--head">
            <span l10nTranslate>Name</span>
            <span l10nTranslate>Description</span>
            <span l10nTranslate>Visibility</span>
            <span l10nTranslate>Members</span>
            <span></span>
          </div>
          @for (g of filtered(); track g.id) {
            <div class="ag-row">
              <span class="ag-row__name">{{ g.name }}</span>
              <span class="ag-row__desc">{{ g.description || '—' }}</span>
              <span>{{ visibilityLabel(g.visibility) }}</span>
              <span class="ag-row__count">
                @if (g.memberCount !== undefined) {
                  {{ g.memberCount }}
                } @else {
                  <button type="button" class="ag-row__count-btn" (click)="loadMemberCount(g)">{{ 'Load' | translate: locale.language }}</button>
                }
              </span>
              <span class="ag-row__actions">
                @if (!isPersonal()) {
                  <button
                    type="button"
                    class="ag-row__action"
                    (click)="openMembers(g)"
                    [attr.title]="'Members' | translate: locale.language"
                    [attr.aria-label]="'Members' | translate: locale.language"
                  >
                    <app-v2-icon name="people" [size]="12" />
                  </button>
                  <button
                    type="button"
                    class="ag-row__action"
                    (click)="openEdit(g)"
                    [attr.title]="'Edit' | translate: locale.language"
                    [attr.aria-label]="'Edit' | translate: locale.language"
                  >
                    <app-v2-icon name="pencil" [size]="12" />
                  </button>
                  <button
                    type="button"
                    class="ag-row__action ag-row__action--danger"
                    (click)="confirmDelete(g)"
                    [attr.title]="'Delete' | translate: locale.language"
                    [attr.aria-label]="'Delete' | translate: locale.language"
                  >
                    <app-v2-icon name="trash" [size]="12" />
                  </button>
                }
              </span>
            </div>
          }
        </div>
      }

      @if (dialog(); as d) {
        <div class="ag-dialog__backdrop" (click)="closeDialog()"></div>
        <div class="ag-dialog" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <div class="ag-dialog__title">
            {{ (d.id ? 'Edit group' : 'New group') | translate: locale.language }}
          </div>
          <div class="ag-dialog__body">
            <label class="ag-field">
              <span l10nTranslate>Name</span>
              <input type="text" [(ngModel)]="d.name" autocomplete="off" />
            </label>
            <label class="ag-field">
              <span l10nTranslate>Description</span>
              <input type="text" [(ngModel)]="d.description" autocomplete="off" />
            </label>
            <label class="ag-field">
              <span l10nTranslate>Visibility</span>
              <select [(ngModel)]="d.visibility">
                <option [ngValue]="GROUP_VISIBILITY.VISIBLE">{{ 'Visible' | translate: locale.language }}</option>
                <option [ngValue]="GROUP_VISIBILITY.PRIVATE">{{ 'Private' | translate: locale.language }}</option>
                <option [ngValue]="GROUP_VISIBILITY.ISOLATED">{{ 'Isolated' | translate: locale.language }}</option>
              </select>
            </label>
            @if (dialogError(); as err) {
              <div class="ag-dialog__error">{{ err }}</div>
            }
          </div>
          <div class="ag-dialog__actions">
            <app-v2-btn kind="ghost" size="sm" (click)="closeDialog()">{{ 'Cancel' | translate: locale.language }}</app-v2-btn>
            <app-v2-btn kind="primary" size="sm" [disabled]="busy() || !canSave()" (click)="save()">
              {{ (d.id ? 'Save' : 'Create') | translate: locale.language }}
            </app-v2-btn>
          </div>
        </div>
      }

      <app-v2-admin-group-members [group]="activeMembersGroup()" (membersChanged)="onMembersChanged($event)" (dismissed)="closeMembers()" />
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
      .ag {
        padding: 22px var(--si-space-12);
        display: flex;
        flex-direction: column;
        gap: var(--si-space-8);
        min-height: 0;
        flex: 1 1 auto;
      }
      .ag__head {
        display: flex;
        align-items: center;
        gap: var(--si-space-6);
      }
      .ag__title-wrap {
        display: flex;
        align-items: baseline;
        gap: var(--si-space-4);
      }
      .ag__title {
        margin: 0;
        font-size: var(--si-text-13);
        font-weight: 700;
        color: var(--si-fg);
        letter-spacing: -0.3px;
        font-family: var(--si-display);
      }
      .ag__count {
        font-size: var(--si-text-4);
        color: var(--si-fg-faint);
        font-family: var(--si-mono);
      }
      .ag__actions {
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: var(--si-space-4);
      }
      .ag__segmented {
        display: inline-flex;
        padding: var(--si-space-1);
        background: var(--si-bg3);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r2);
        gap: var(--si-space-1);
      }
      .ag__seg {
        background: transparent;
        border: none;
        padding: var(--si-space-2) var(--si-space-6);
        font: inherit;
        font-size: var(--si-text-5);
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
      .ag__search {
        width: 220px;
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
      .ag__state {
        padding: 60px var(--si-space-10);
        text-align: center;
        font-size: var(--si-text-8);
        color: var(--si-fg-muted);
        &--error {
          color: var(--si-rose);
        }
      }
      .ag-table {
        display: flex;
        flex-direction: column;
        background: var(--si-bg2);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r3);
        overflow: hidden;
      }
      .ag-row {
        display: grid;
        grid-template-columns: 1.5fr 2.2fr 1fr 0.8fr 80px;
        gap: var(--si-space-7);
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
          color: var(--si-fg-faint);
          font-weight: 600;
          font-family: var(--si-display);
        }
      }
      .ag-row__name {
        font-weight: 500;
      }
      .ag-row__desc {
        color: var(--si-fg-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ag-row__count {
        font-family: var(--si-mono);
        font-size: var(--si-text-5);
      }
      .ag-row__count-btn {
        background: transparent;
        border: none;
        color: var(--si-nav);
        font-size: var(--si-text-2);
        text-transform: uppercase;
        letter-spacing: 1px;
        cursor: pointer;
        padding: 0;
        font-weight: 600;

        &:hover {
          text-decoration: underline;
        }
      }
      .ag-row__actions {
        display: inline-flex;
        justify-content: flex-end;
        gap: var(--si-space-2);
      }
      .ag-row__action {
        width: 24px;
        height: 24px;
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

      .ag-dialog__backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.35);
        z-index: var(--si-z-dialog);
      }
      .ag-dialog {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 440px;
        max-height: 80vh;
        overflow: auto;
        z-index: calc(var(--si-z-dialog) + 1);
        background: var(--si-bg2);
        border: 1px solid var(--si-line);
        border-radius: var(--si-r3);
        box-shadow: var(--si-shadow2, 0 16px 32px rgba(0, 0, 0, 0.35));
        padding: var(--si-space-9) var(--si-space-10);
        display: flex;
        flex-direction: column;
        gap: var(--si-space-7);
      }
      .ag-dialog__title {
        font-size: var(--si-text-11);
        font-weight: 600;
        color: var(--si-fg);
      }
      .ag-dialog__body {
        display: flex;
        flex-direction: column;
        gap: var(--si-space-5);
      }
      .ag-field {
        display: flex;
        flex-direction: column;
        gap: var(--si-space-2);
      }
      .ag-field > span {
        font-size: var(--si-text-3);
        text-transform: uppercase;
        letter-spacing: 1px;
        color: var(--si-fg-faint);
        font-weight: 600;
      }
      .ag-field input[type='text'],
      .ag-field select {
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
      .ag-dialog__error {
        color: var(--si-rose);
        font-size: var(--si-text-6);
      }
      .ag-dialog__actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--si-space-4);
      }
    `
  ]
})
export class AdminGroupsComponent implements OnInit {
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  protected readonly GROUP_VISIBILITY = GROUP_VISIBILITY
  private readonly admin = inject(AdminService)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  private readonly toast = inject(ToastService)
  private readonly confirm = inject(ConfirmDialogService)

  protected readonly groups = signal<GroupRow[]>([])
  protected readonly isPersonal = signal(false)
  protected readonly loading = signal(true)
  protected readonly errorMessage = signal<string | null>(null)
  protected readonly search = signal('')
  protected readonly dialog = signal<GroupDraft | null>(null)
  protected readonly dialogError = signal<string | null>(null)
  protected readonly busy = signal(false)
  protected readonly activeMembersGroup = signal<GroupRef | null>(null)

  protected readonly filtered = computed(() => {
    const q = this.search().toLowerCase().trim()
    const list = this.groups()
    if (!q) return list
    return list.filter((g) => g.name.toLowerCase().includes(q) || (g.description ?? '').toLowerCase().includes(q))
  })

  ngOnInit(): void {
    this.breadcrumbs.setBreadcrumbs([{ label: 'Administration', icon: 'person', route: ['/', V2_PATH, V2_ROUTES.ADMIN] }, { label: 'Groups' }])
    this.refresh()
  }

  protected refresh(): void {
    this.loading.set(true)
    this.errorMessage.set(null)
    // Browse the root (no name) — returns top-level groups as members.
    this.admin.browseGroup(undefined, this.isPersonal()).subscribe({
      next: (browse: GroupBrowseModel) => {
        const rows: GroupRow[] = (browse.members ?? []).map((m) => ({
          id: m.id,
          name: m.name ?? '',
          description: m.description ?? null,
          // Visibility is not returned by the browse endpoint; default Visible and
          // let the detail fetch in openEdit() pull the real value.
          visibility: GROUP_VISIBILITY.VISIBLE
        }))
        this.groups.set(rows)
        this.loading.set(false)
      },
      error: (e: HttpErrorResponse) => {
        this.errorMessage.set(e.error?.message ?? 'Failed to load groups')
        this.loading.set(false)
      }
    })
  }

  protected setIsPersonal(value: boolean): void {
    if (this.isPersonal() === value) return
    this.isPersonal.set(value)
    this.groups.set([])
    this.search.set('')
    this.refresh()
  }

  protected onSearch(ev: Event): void {
    this.search.set((ev.target as HTMLInputElement).value)
  }

  protected visibilityLabel(v: GROUP_VISIBILITY): string {
    switch (v) {
      case GROUP_VISIBILITY.PRIVATE:
        return 'Private'
      case GROUP_VISIBILITY.ISOLATED:
        return 'Isolated'
      case GROUP_VISIBILITY.VISIBLE:
      default:
        return 'Visible'
    }
  }

  protected loadMemberCount(row: GroupRow): void {
    this.admin.browseGroup(row.name, this.isPersonal()).subscribe({
      next: (browse: GroupBrowseModel) => {
        const count = (browse.members ?? []).length
        this.groups.update((list) => list.map((g) => (g.id === row.id ? { ...g, memberCount: count } : g)))
      },
      error: () => {
        /* silent — count is optional */
      }
    })
  }

  protected openCreate(): void {
    this.dialogError.set(null)
    this.dialog.set(emptyDraft())
  }

  protected openEdit(row: GroupRow): void {
    this.dialogError.set(null)
    // Fetch fresh detail so visibility, etc., reflect the server.
    this.admin.getGroup(row.id).subscribe({
      next: (g: AdminGroupModel) => {
        this.dialog.set({
          id: g.id,
          name: g.name ?? '',
          description: g.description ?? '',
          visibility: g.visibility ?? GROUP_VISIBILITY.VISIBLE
        })
      },
      error: (e: HttpErrorResponse) => {
        this.toast.error(e.error?.message ?? 'Failed to load group')
      }
    })
  }

  protected closeDialog(): void {
    if (this.busy()) return
    this.dialog.set(null)
    this.dialogError.set(null)
  }

  protected canSave(): boolean {
    const d = this.dialog()
    return !!d && d.name.trim().length > 0
  }

  protected save(): void {
    const d = this.dialog()
    if (!d || !this.canSave()) return
    this.busy.set(true)
    this.dialogError.set(null)
    const dto: CreateOrUpdateGroupDto = {
      name: d.name.trim(),
      description: d.description.trim(),
      visibility: d.visibility
    }
    if (d.id) {
      this.admin.updateGroup(d.id, dto).subscribe({
        next: (updated) => this.onSaved(updated, d.id!),
        error: (e: HttpErrorResponse) => this.onError(e)
      })
    } else {
      this.admin.createGroup(dto).subscribe({
        next: (created) => this.onSaved(created),
        error: (e: HttpErrorResponse) => this.onError(e)
      })
    }
  }

  private onSaved(g: AdminGroupModel, editedId?: number): void {
    this.busy.set(false)
    this.dialog.set(null)
    const row: GroupRow = {
      id: g.id,
      name: g.name ?? '',
      description: g.description ?? null,
      visibility: g.visibility
    }
    if (editedId !== undefined) {
      this.groups.update((list) => list.map((x) => (x.id === editedId ? { ...row, memberCount: x.memberCount } : x)))
      this.toast.success('Group updated')
    } else {
      this.groups.update((list) => [row, ...list])
      this.toast.success('Group created')
    }
  }

  private onError(e: HttpErrorResponse): void {
    this.busy.set(false)
    this.dialogError.set(e.error?.message ?? 'Unable to save group')
  }

  protected openMembers(row: GroupRow): void {
    this.activeMembersGroup.set({ id: row.id, name: row.name })
  }

  protected closeMembers(): void {
    this.activeMembersGroup.set(null)
  }

  protected onMembersChanged(count: number): void {
    const g = this.activeMembersGroup()
    if (!g) return
    this.groups.update((list) => list.map((x) => (x.id === g.id ? { ...x, memberCount: count } : x)))
  }

  protected async confirmDelete(row: GroupRow): Promise<void> {
    const ok = await this.confirm.open({
      title: 'Delete group',
      message: 'v2_delete_group',
      messageParams: { name: row.name },
      confirmLabel: 'Delete',
      kind: 'danger'
    })
    if (!ok) return
    this.admin.deleteGroup(row.id).subscribe({
      next: () => {
        this.groups.update((list) => list.filter((g) => g.id !== row.id))
        this.toast.success('Group deleted')
      },
      error: (e: HttpErrorResponse) => {
        this.toast.error(e.error?.message ?? 'Delete failed')
      }
    })
  }
}
