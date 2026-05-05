import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  EventEmitter,
  HostListener,
  inject,
  Input,
  OnDestroy,
  Output,
  signal,
  ViewChild,
  OnChanges
} from '@angular/core'
import { Subject, Subscription } from 'rxjs'
import { debounceTime, distinctUntilChanged, switchMap } from 'rxjs/operators'
import { MEMBER_TYPE } from '@sync-in-server/backend/src/applications/users/constants/member'
import { USER_ROLE } from '@sync-in-server/backend/src/applications/users/constants/user'
import type { CreateOrUpdateSpaceDto, SpaceMemberDto } from '@sync-in-server/backend/src/applications/spaces/dto/create-or-update-space.dto'
import { AdminService } from '../../../admin/admin.service'
import { SpacesService } from '../../../spaces/services/spaces.service'
import { SpaceModel } from '../../../spaces/models/space.model'
import { StoreService } from '../../../../store/store.service'
import { UserService } from '../../../users/user.service'
import { MemberModel } from '../../../users/models/member.model'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { ButtonComponent } from '../../components/button.component'
import { IconButtonComponent } from '../../components/icon-button.component'
import { AvatarComponent, AvatarUser } from '../../components/avatar.component'
import { IconV2Component } from '../../icons/icon-v2.component'

type Tab = 'settings' | 'files' | 'members' | 'links'

@Component({
  selector: 'app-v2-create-space-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './create-space-modal.component.html',
  styleUrl: './create-space-modal.component.scss',
  imports: [IconV2Component, IconButtonComponent, ButtonComponent, AvatarComponent, L10nTranslateDirective, L10nTranslatePipe]
})
export class CreateSpaceModalComponent implements OnDestroy, OnChanges {
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  @Input({ required: true }) open = false
  @Output() closed = new EventEmitter<void>()
  @Output() created = new EventEmitter<SpaceModel>()

  @ViewChild('nameInput') nameInputEl: ElementRef<HTMLInputElement> | undefined

  private readonly spacesService = inject(SpacesService)
  private readonly userService = inject(UserService)
  private readonly adminService = inject(AdminService)
  private readonly store = inject(StoreService)
  private readonly isAdmin: boolean = this.store.user.getValue()?.role === USER_ROLE.ADMINISTRATOR

  protected readonly tab = signal<Tab>('settings')
  protected readonly name = signal('')
  protected readonly description = signal('')
  protected readonly quotaMb = signal<number | null>(null)
  protected readonly managers = signal<MemberModel[]>([])

  protected readonly managerQuery = signal('')
  protected readonly managerResults = signal<MemberModel[]>([])
  protected readonly managerSearching = signal(false)
  protected readonly managerDropdownOpen = signal(false)

  protected readonly submitting = signal(false)
  protected readonly errorMessage = signal<string | null>(null)

  protected readonly canSubmit = computed(() => this.name().trim().length > 0 && this.managers().length > 0 && !this.submitting())

  private readonly query$ = new Subject<string>()
  private readonly subs = new Subscription()

  constructor() {
    this.subs.add(
      this.query$
        .pipe(
          debounceTime(220),
          distinctUntilChanged(),
          switchMap((q) => {
            const trimmed = q.trim()
            if (trimmed.length < 1) {
              this.managerSearching.set(false)
              this.managerResults.set([])
              return []
            }
            this.managerSearching.set(true)
            const ignoreUserIds = this.managers().map((m) => m.id)
            const svc = this.isAdmin ? this.adminService : this.userService
            return svc.searchMembers({ search: trimmed, onlyUsers: true, ignoreUserIds })
          })
        )
        .subscribe({
          next: (members) => {
            this.managerResults.set(members)
            this.managerSearching.set(false)
            this.managerDropdownOpen.set(true)
          },
          error: () => {
            this.managerResults.set([])
            this.managerSearching.set(false)
          }
        })
    )
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe()
  }

  ngOnChanges(): void {
    if (this.open) {
      // Defer focus so the input exists in the DOM
      queueMicrotask(() => this.nameInputEl?.nativeElement?.focus())
    }
  }

  @HostListener('window:keydown.escape')
  onEscape(): void {
    if (this.open && !this.submitting()) {
      this.close()
    }
  }

  protected onBackdropClick(): void {
    if (!this.submitting()) this.close()
  }

  protected stopPropagation(ev: Event): void {
    ev.stopPropagation()
  }

  protected setTab(t: Tab): void {
    this.tab.set(t)
  }

  protected onNameInput(ev: Event): void {
    this.name.set((ev.target as HTMLInputElement).value)
  }

  protected onDescriptionInput(ev: Event): void {
    this.description.set((ev.target as HTMLTextAreaElement).value)
  }

  protected onQuotaInput(ev: Event): void {
    const v = (ev.target as HTMLInputElement).value
    const n = v === '' ? null : Number(v)
    this.quotaMb.set(Number.isFinite(n as number) && (n as number) > 0 ? (n as number) : null)
  }

  protected onManagerQueryInput(ev: Event): void {
    const value = (ev.target as HTMLInputElement).value
    this.managerQuery.set(value)
    this.query$.next(value)
  }

  protected onManagerQueryFocus(): void {
    if (this.managerResults().length > 0) {
      this.managerDropdownOpen.set(true)
    }
  }

  protected onManagerQueryBlur(): void {
    // Slight delay so a click on a dropdown item registers first.
    setTimeout(() => this.managerDropdownOpen.set(false), 120)
  }

  protected addManager(m: MemberModel): void {
    if (this.managers().some((x) => x.id === m.id)) return
    this.managers.update((list) => [...list, m])
    this.managerQuery.set('')
    this.managerResults.set([])
    this.managerDropdownOpen.set(false)
  }

  protected removeManager(m: MemberModel): void {
    this.managers.update((list) => list.filter((x) => x.id !== m.id))
  }

  protected avatarUser(m: { login?: string; name: string }): AvatarUser {
    const seed = m.login || m.name || ''
    let h = 0
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
    const parts = (m.name || m.login || '').trim().split(/\s+/).filter(Boolean)
    const initials =
      parts
        .slice(0, 2)
        .map((p) => p[0])
        .join('')
        .toUpperCase() || '?'
    return { initials, hue: h % 360 }
  }

  protected submit(): void {
    if (!this.canSubmit()) return
    this.submitting.set(true)
    this.errorMessage.set(null)
    const dto: CreateOrUpdateSpaceDto = {
      name: this.name().trim(),
      description: this.description().trim() || undefined,
      enabled: true,
      storageQuota: this.quotaMb() != null ? (this.quotaMb() as number) * 1024 * 1024 : undefined,
      managers: this.managers().map(
        (m) =>
          ({
            id: m.id,
            type: MEMBER_TYPE.USER
          }) as SpaceMemberDto
      ),
      members: [],
      links: [],
      roots: []
    }
    this.spacesService.createSpace(dto).subscribe({
      next: (space) => {
        this.submitting.set(false)
        this.created.emit(space)
        this.reset()
      },
      error: (err) => {
        this.submitting.set(false)
        const msg = err?.error?.message || err?.message || 'Failed to create space.'
        this.errorMessage.set(typeof msg === 'string' ? msg : 'Failed to create space.')
      }
    })
  }

  protected close(): void {
    this.closed.emit()
    this.reset()
  }

  private reset(): void {
    this.tab.set('settings')
    this.name.set('')
    this.description.set('')
    this.quotaMb.set(null)
    this.managers.set([])
    this.managerQuery.set('')
    this.managerResults.set([])
    this.managerDropdownOpen.set(false)
    this.errorMessage.set(null)
  }
}
