import { ChangeDetectionStrategy, Component, computed, HostListener, inject } from '@angular/core'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { StoreService } from '../../../store/store.service'
import { fileLockPropsToString } from '../../files/components/utils/file-lock.utils'
import { userAvatarUrl } from '../../users/user.functions'
import { AvatarComponent, avatarTone, avatarInitials, type AvatarUser } from './avatar.component'
import { ButtonComponent } from './button.component'
import { IconV2Component } from '../icons/icon-v2.component'
import { LockDialogService } from './lock-dialog.service'

// v2's unlock dialog — the same three-way branch as classic's
// FilesLockDialogComponent, rendered with the v2 design tokens:
//
//   lock owner OR file owner → Unlock          (filesService.unlock)
//   not the lock owner       → Send an unlock request (filesService.unlockRequest)
//   neither                  → the request button alone
//
// Both buttons show at once when the user is the file owner but not the lock
// owner, which is classic's behaviour and the reason its body carries the
// "as the file owner…" hint. A NON-exclusive lock (a co-editing session) is
// informational only: classic shows just Close, and so does this.
//
// `isLockOwner` is derived here rather than passed in because it is a pure
// function of the row plus the logged-in login. `isFileOwner` is passed in —
// half of classic's expression for it is screen state, not row state. See
// LockDialogOptions.
//
// There is deliberately NO "lock this file" affordance. Classic has none; locks
// are taken by editor sessions only.
@Component({
  selector: 'app-v2-lock-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, ButtonComponent, IconV2Component, L10nTranslatePipe],
  template: `
    @if (pending(); as p) {
      <div class="lock-dialog__backdrop" (click)="cancel()" (contextmenu)="$event.preventDefault()"></div>
      <div class="lock-dialog" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
        <div class="lock-dialog__title">
          <app-v2-icon [name]="p.lock.isExclusive ? 'lock' : 'unlock'" [size]="15" />
          <span class="lock-dialog__file">{{ p.fileName }}</span>
        </div>
        <div class="lock-dialog__owner">
          <span class="lock-dialog__owner-label">
            {{ (p.lock.isExclusive ? 'The file is locked by' : 'The file is edited by') | translate: locale.language }}
          </span>
          <app-v2-avatar [user]="avatar()!" [size]="48" />
          <span class="lock-dialog__owner-name">{{ ownerLabel() }}</span>
        </div>
        @if (p.lock.isExclusive && !isLockOwner() && p.isFileOwner) {
          <div class="lock-dialog__hint">
            {{ 'As the file owner, you can unlock the file or request the current lock owner to release it.' | translate: locale.language }}
          </div>
        }
        <div class="lock-dialog__actions">
          <app-v2-btn kind="ghost" size="sm" (click)="cancel()">
            {{ (p.lock.isExclusive ? 'Cancel' : 'Close') | translate: locale.language }}
          </app-v2-btn>
          @if (p.lock.isExclusive) {
            @if (!isLockOwner()) {
              <app-v2-btn kind="ghost" size="sm" (click)="choose('request')">
                {{ 'Send an unlock request' | translate: locale.language }}
              </app-v2-btn>
            }
            @if (isLockOwner() || p.isFileOwner) {
              <app-v2-btn kind="primary" size="sm" (click)="choose('unlock')">
                {{ 'Unlock' | translate: locale.language }}
              </app-v2-btn>
            }
          }
        </div>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }
      .lock-dialog__backdrop {
        position: fixed;
        inset: 0;
        background: var(--si-scrim);
        z-index: var(--si-z-dialog);
      }
      .lock-dialog {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: calc(var(--si-z-dialog) + 1);
        min-width: 320px;
        max-width: 420px;
        padding: var(--si-space-9) var(--si-space-10) var(--si-space-7);
        background: var(--si-bg1);
        border: 1px solid var(--si-border);
        border-radius: 10px;
        box-shadow: var(--si-shadow3);
      }
      .lock-dialog__title {
        display: flex;
        align-items: center;
        gap: var(--si-space-4);
        font-size: var(--si-text-11);
        font-weight: 600;
        color: var(--si-fg);
        margin-bottom: var(--si-space-7);
      }
      .lock-dialog__file {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .lock-dialog__owner {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--si-space-4);
        text-align: center;
      }
      .lock-dialog__owner-label {
        font-size: var(--si-text-8);
        color: var(--si-fg-muted);
      }
      .lock-dialog__owner-name {
        font-size: var(--si-text-8);
        font-weight: 600;
        color: var(--si-fg);
        overflow-wrap: anywhere;
      }
      .lock-dialog__hint {
        margin-top: var(--si-space-7);
        font-size: var(--si-text-6);
        color: var(--si-fg-muted);
        line-height: 1.45;
        text-align: center;
      }
      .lock-dialog__actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--si-space-4);
        justify-content: flex-end;
        margin-top: var(--si-space-8);
      }
    `
  ]
})
export class LockDialogComponent {
  private readonly service = inject(LockDialogService)
  private readonly store = inject(StoreService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  protected readonly pending = this.service.pending

  /**
   * Whether the logged-in user holds the lock — classic's
   * `file.lock.owner.login === user.login`.
   *
   * A login match is all the props can tell us. Nothing in `FileLockProps`
   * distinguishes THIS session's lock from another lock by the same user in
   * another tab or app, so this deliberately answers the weaker question and
   * offers Unlock either way. See custom-v2/utils/file-writeable.ts for the same
   * limitation seen from the writeability side.
   */
  protected readonly isLockOwner = computed(() => {
    const p = this.pending()
    if (!p) return false
    const login = this.store.user.getValue()?.login
    return !!login && p.lock.owner?.login === login
  })

  /** `Full Name (email) - <info> <app>`, exactly as classic's FileLockFormatPipe renders it. */
  protected readonly ownerLabel = computed(() => {
    const p = this.pending()
    return p ? fileLockPropsToString(p.lock) : ''
  })

  protected readonly avatar = computed<AvatarUser | null>(() => {
    const p = this.pending()
    if (!p) return null
    const owner = p.lock.owner
    const label = owner?.fullName || owner?.login || ''
    return {
      initials: avatarInitials(label),
      tone: avatarTone(owner?.login || label),
      // Classic renders userAvatarUrl(file.lock.owner.login); the gradient +
      // initials are the fallback when there is no login to address.
      imageUrl: owner?.login ? userAvatarUrl(owner.login) : null
    }
  })

  protected choose(choice: 'unlock' | 'request'): void {
    this.service.resolve(choice)
  }

  protected cancel(): void {
    this.service.resolve(null)
  }

  @HostListener('window:keydown.escape')
  onEscape(): void {
    if (this.pending()) this.cancel()
  }

  // Mirrors classic's onEnter: unlock when the user may, otherwise send the
  // request. Never fires for a non-exclusive lock — that dialog has no action.
  @HostListener('window:keydown.enter')
  onEnter(): void {
    const p = this.pending()
    if (!p || !p.lock.isExclusive) return
    if (this.isLockOwner() || p.isFileOwner) this.choose('unlock')
    else this.choose('request')
  }
}
