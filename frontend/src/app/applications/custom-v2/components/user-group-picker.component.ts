import { HttpClient } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, EventEmitter, inject, Input, Output, signal, ViewChild } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { MEMBER_TYPE } from '@sync-in-server/backend/src/applications/users/constants/member'
import { API_ADMIN_MEMBERS, USERS_ROUTE } from '@sync-in-server/backend/src/applications/users/constants/routes'
import type { Member } from '@sync-in-server/backend/src/applications/users/interfaces/member.interface'
import type { SearchMembersDto } from '@sync-in-server/backend/src/applications/users/dto/search-members.dto'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { debounceTime, Subject, switchMap } from 'rxjs'
import { userAvatarUrl } from '../../users/user.functions'

export interface PickedMember {
  id: number
  type: MEMBER_TYPE
  name: string
  description?: string
  login?: string
  avatarUrl?: string
}

@Component({
  selector: 'app-v2-user-group-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [L10nTranslatePipe],
  template: `
    <div class="ugp">
      <input
        #input
        type="text"
        class="ugp__input"
        [placeholder]="placeholder | translate: locale.language"
        [value]="query()"
        (input)="onInput($event)"
        (focus)="showResults.set(true)"
        (blur)="onBlur()"
        autocomplete="off"
      />
      @if (showResults() && query().trim().length > 0) {
        <div class="ugp__results" (mousedown)="$event.preventDefault()">
          @if (loading()) {
            <div class="ugp__hint">{{ 'Searching…' | translate: locale.language }}</div>
          } @else if (results().length === 0) {
            <div class="ugp__hint">{{ 'No matches' | translate: locale.language }}</div>
          } @else {
            @for (m of results(); track m.id + ':' + m.type) {
              <button type="button" class="ugp__result" (click)="select(m)">
                @if (m.avatarUrl) {
                  <img class="ugp__avatar" [src]="m.avatarUrl" alt="" />
                } @else {
                  <span class="ugp__glyph">{{ m.type === 'group' || m.type === 'personal group' ? '⚑' : '@' }}</span>
                }
                <span class="ugp__name">{{ m.name }}</span>
                @if (m.description) {
                  <span class="ugp__desc">{{ m.description }}</span>
                }
                <span class="ugp__type">{{ typeLabel(m.type) | translate: locale.language }}</span>
              </button>
            }
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        position: relative;
      }
      .ugp__input {
        width: 100%;
        box-sizing: border-box;
        font: inherit;
        font-size: 13px;
        padding: 8px 10px;
        background: var(--si-bg2);
        color: var(--si-fg);
        border: 1px solid var(--si-border);
        border-radius: 6px;
        outline: none;
      }
      .ugp__input:focus {
        border-color: color-mix(in srgb, var(--si-accent, #3b82f6) 60%, var(--si-border));
      }
      .ugp__results {
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        right: 0;
        max-height: 240px;
        overflow-y: auto;
        background: var(--si-bg1);
        border: 1px solid var(--si-border);
        border-radius: 8px;
        box-shadow: 0 8px 20px rgba(0, 0, 0, 0.22);
        z-index: 2;
      }
      .ugp__hint {
        padding: 10px 12px;
        font-size: 12.5px;
        color: var(--si-fg-muted);
      }
      .ugp__result {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 8px 10px;
        background: transparent;
        color: var(--si-fg);
        border: none;
        border-bottom: 1px solid color-mix(in srgb, var(--si-border) 50%, transparent);
        text-align: left;
        font: inherit;
        font-size: 13px;
        cursor: pointer;
      }
      .ugp__result:last-child {
        border-bottom: none;
      }
      .ugp__result:hover {
        background: var(--si-bg3);
      }
      .ugp__avatar {
        width: 22px;
        height: 22px;
        border-radius: 50%;
        object-fit: cover;
      }
      .ugp__glyph {
        width: 22px;
        height: 22px;
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: var(--si-bg3);
        color: var(--si-fg-muted);
        font-size: 12px;
      }
      .ugp__name {
        font-weight: 500;
      }
      .ugp__desc {
        color: var(--si-fg-muted);
        font-size: 12px;
      }
      .ugp__type {
        margin-left: auto;
        color: var(--si-fg-muted);
        font-size: 11.5px;
        text-transform: lowercase;
      }
    `
  ]
})
export class UserGroupPickerComponent {
  private readonly http = inject(HttpClient)
  private readonly destroyRef = inject(DestroyRef)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  @Input() placeholder = 'Search people or groups'
  @Input() ignoreUserIds: number[] = []
  @Input() ignoreGroupIds: number[] = []
  // When true, searches /api/admin/members (all users the admin can administrate)
  // instead of the default /api/users (members visible to the current user).
  @Input() adminScope = false
  @Input() onlyUsers = false
  @Output() pick = new EventEmitter<PickedMember>()

  @ViewChild('input') protected input?: ElementRef<HTMLInputElement>

  protected readonly query = signal('')
  protected readonly loading = signal(false)
  protected readonly results = signal<PickedMember[]>([])
  protected readonly showResults = signal(false)

  private readonly input$ = new Subject<string>()

  constructor() {
    this.input$
      .pipe(
        debounceTime(180),
        switchMap((q) => {
          const trimmed = q.trim()
          if (trimmed.length === 0) {
            this.loading.set(false)
            this.results.set([])
            return []
          }
          this.loading.set(true)
          const body: SearchMembersDto = {
            search: trimmed,
            ignoreUserIds: this.ignoreUserIds,
            ignoreGroupIds: this.ignoreGroupIds,
            onlyUsers: this.onlyUsers || undefined
          }
          const url = this.adminScope ? API_ADMIN_MEMBERS : USERS_ROUTE.BASE
          return this.http.request<Member[]>('search', url, { body })
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe({
        next: (members) => {
          if (!Array.isArray(members)) return
          this.results.set(members.map((m) => this.toPicked(m)))
          this.loading.set(false)
        },
        error: () => {
          this.results.set([])
          this.loading.set(false)
        }
      })
  }

  focus(): void {
    queueMicrotask(() => this.input?.nativeElement.focus())
  }

  clear(): void {
    this.query.set('')
    this.results.set([])
    this.showResults.set(false)
  }

  protected onInput(ev: Event): void {
    const value = (ev.target as HTMLInputElement).value
    this.query.set(value)
    this.showResults.set(true)
    this.input$.next(value)
  }

  protected onBlur(): void {
    // Delay so clicks on results can fire first.
    setTimeout(() => this.showResults.set(false), 160)
  }

  protected select(m: PickedMember): void {
    this.clear()
    this.pick.emit(m)
  }

  protected typeLabel(t: MEMBER_TYPE): string {
    if (t === MEMBER_TYPE.GROUP || t === MEMBER_TYPE.PGROUP) return 'group'
    if (t === MEMBER_TYPE.GUEST) return 'guest'
    return 'user'
  }

  private toPicked(m: Member): PickedMember {
    return {
      id: m.id,
      type: m.type,
      name: m.name,
      description: m.description,
      login: m.login,
      avatarUrl: m.login ? userAvatarUrl(m.login) : undefined
    }
  }
}
