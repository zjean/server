import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, effect, HostListener, inject, signal, untracked } from '@angular/core'
import type { LinkGuest } from '@sync-in-server/backend/src/applications/links/interfaces/link-guest.interface'
import type { ShareProps } from '@sync-in-server/backend/src/applications/shares/interfaces/share-props.interface'
import { USER_PASSWORD_MIN_LENGTH } from '@sync-in-server/backend/src/applications/users/constants/user'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import {
  buildPublicLinkUrl,
  createLinkShare,
  deleteLinkShare,
  generateLinkPassword,
  genLinkUuid,
  type LinkSettingsInput,
  updateLinkOnShare
} from '../utils/link-share'
import { ButtonComponent } from './button.component'
import { LinkDialogService } from './link-dialog.service'
import { ToastService } from './toast.service'

interface FormState {
  requireAuth: boolean
  password: string
  hasExpiry: boolean
  expiresAt: string // ISO yyyy-MM-dd, for <input type="date">
}

@Component({
  selector: 'app-v2-link-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, L10nTranslatePipe],
  template: `
    @if (pending(); as p) {
      <div class="ld__backdrop" (click)="cancel()"></div>
      <div class="ld" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
        <div class="ld__title">
          {{ (isEdit() ? 'v2_link_edit_title' : 'v2_link_create_title') | translate: locale.language }}
        </div>
        <div class="ld__subject" [attr.title]="subjectName()">{{ subjectName() }}</div>

        @if (urlReady(); as url) {
          <div class="ld__url-row">
            <input class="ld__url-input" readonly [value]="url" (focus)="selectAll($event)" />
            <app-v2-btn kind="secondary" size="sm" icon="copy" (click)="copy(url)">
              {{ 'v2_link_copy' | translate: locale.language }}
            </app-v2-btn>
          </div>
        }

        <div class="ld__field">
          <label class="ld__toggle">
            <input type="checkbox" [checked]="form().requireAuth" (change)="onToggleAuth($event)" />
            <span>{{ 'v2_link_require_password' | translate: locale.language }}</span>
          </label>
          @if (form().requireAuth) {
            <div class="ld__row">
              <input
                type="text"
                class="ld__input"
                [value]="form().password"
                (input)="onPasswordInput($event)"
                [placeholder]="passwordPlaceholder()"
                [attr.minlength]="passwordMinLength"
                autocomplete="new-password"
              />
              <app-v2-btn kind="ghost" size="sm" icon="refresh" (click)="generate()">
                {{ 'v2_link_generate' | translate: locale.language }}
              </app-v2-btn>
            </div>
            @if (passwordError(); as err) {
              <div class="ld__error">{{ err | translate: locale.language }}</div>
            }
          }
        </div>

        <div class="ld__field">
          <label class="ld__toggle">
            <input type="checkbox" [checked]="form().hasExpiry" (change)="onToggleExpiry($event)" />
            <span>{{ 'v2_link_set_expiry' | translate: locale.language }}</span>
          </label>
          @if (form().hasExpiry) {
            <input type="date" class="ld__input ld__input--date" [value]="form().expiresAt" [min]="minExpiryDate" (input)="onExpiryInput($event)" />
          }
        </div>

        @if (errorMessage(); as err) {
          <div class="ld__error">{{ err }}</div>
        }

        <div class="ld__actions">
          @if (isEdit()) {
            <app-v2-btn kind="danger" size="sm" icon="trash" [disabled]="busy()" (click)="revoke()">
              {{ 'v2_link_revoke' | translate: locale.language }}
            </app-v2-btn>
          }
          <span class="ld__spacer"></span>
          <app-v2-btn kind="ghost" size="sm" (click)="cancel()">
            {{ (urlReady() ? 'v2_link_close' : 'Cancel') | translate: locale.language }}
          </app-v2-btn>
          @if (!urlReady()) {
            <app-v2-btn kind="primary" size="sm" [disabled]="!canSubmit()" (click)="submit()">
              {{ (isEdit() ? 'v2_link_save' : 'v2_link_create') | translate: locale.language }}
            </app-v2-btn>
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
      .ld__backdrop {
        position: fixed;
        inset: 0;
        background: var(--si-scrim);
        z-index: var(--si-z-dialog);
      }
      .ld {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: calc(var(--si-z-dialog) + 1);
        width: min(440px, calc(100vw - 24px));
        padding: var(--si-space-9) var(--si-space-10) var(--si-space-8);
        background: var(--si-bg1);
        border: 1px solid var(--si-border);
        border-radius: 10px;
        box-shadow: var(--si-shadow3);
      }
      .ld__title {
        font-size: var(--si-text-11);
        font-weight: 600;
        color: var(--si-fg);
        margin-bottom: var(--si-space-1);
      }
      .ld__subject {
        font-size: var(--si-text-7);
        color: var(--si-fg-muted);
        margin-bottom: var(--si-space-7);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ld__url-row {
        display: flex;
        gap: var(--si-space-3);
        align-items: center;
        margin-bottom: var(--si-space-7);
      }
      .ld__url-input {
        flex: 1;
        min-width: 0;
        box-sizing: border-box;
        font: inherit;
        font-size: var(--si-text-6);
        padding: var(--si-space-4) 9px;
        background: var(--si-bg2);
        color: var(--si-fg);
        border: 1px solid var(--si-border);
        border-radius: 6px;
      }
      .ld__field {
        margin-bottom: var(--si-space-6);
      }
      .ld__toggle {
        display: inline-flex;
        align-items: center;
        gap: var(--si-space-4);
        font-size: var(--si-text-8);
        color: var(--si-fg);
        cursor: pointer;
        user-select: none;
      }
      .ld__toggle input[type='checkbox'] {
        accent-color: var(--si-accent);
      }
      .ld__row {
        display: flex;
        gap: var(--si-space-3);
        align-items: center;
        margin-top: var(--si-space-3);
      }
      .ld__input {
        flex: 1;
        min-width: 0;
        box-sizing: border-box;
        font: inherit;
        font-size: var(--si-text-8);
        padding: var(--si-space-4) var(--si-space-5);
        background: var(--si-bg2);
        color: var(--si-fg);
        border: 1px solid var(--si-border);
        border-radius: 6px;
        outline: none;
        transition: border-color 120ms ease;
      }
      .ld__input:focus {
        border-color: color-mix(in srgb, var(--si-accent) 60%, var(--si-border));
      }
      .ld__input--date {
        margin-top: var(--si-space-3);
      }
      .ld__error {
        font-size: var(--si-text-5);
        color: var(--si-rose-ink);
        margin-top: var(--si-space-3);
      }
      .ld__actions {
        display: flex;
        gap: var(--si-space-4);
        align-items: center;
        margin-top: var(--si-space-7);
      }
      .ld__spacer {
        flex: 1;
      }
    `
  ]
})
export class LinkDialogComponent {
  private readonly service = inject(LinkDialogService)
  private readonly http = inject(HttpClient)
  private readonly toast = inject(ToastService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  protected readonly passwordMinLength = USER_PASSWORD_MIN_LENGTH
  protected readonly minExpiryDate = new Date().toISOString().slice(0, 10)

  protected readonly pending = this.service.pending

  protected readonly isEdit = computed(() => !!this.pending()?.existing)

  protected readonly subjectName = computed(() => {
    const p = this.pending()
    if (!p) return ''
    return p.existing?.name ?? p.file?.name ?? ''
  })

  protected readonly form = signal<FormState>({
    requireAuth: false,
    password: '',
    hasExpiry: false,
    expiresAt: ''
  })

  protected readonly urlReady = signal<string | null>(null)
  protected readonly busy = signal(false)
  protected readonly errorMessage = signal<string | null>(null)
  // uuid of the link-in-flight. For create we fetch once at open; for edit we read from existing.
  protected readonly pendingUuid = signal<string | null>(null)
  // On edit we track (shareId, linkId) once the dialog is open.
  protected readonly editIds = signal<{ shareId: number; linkId: number } | null>(null)

  constructor() {
    effect(() => {
      const p = this.pending()
      untracked(() => {
        if (!p) {
          this.resetState()
          return
        }
        if (p.existing) {
          const existing = p.existing
          this.form.set({
            requireAuth: existing.link.requireAuth ?? false,
            password: '',
            hasExpiry: !!existing.link.expiresAt,
            expiresAt: existing.link.expiresAt ? toDateInputValue(existing.link.expiresAt) : ''
          })
          this.pendingUuid.set(existing.link.uuid)
          this.editIds.set({ shareId: existing.id, linkId: existing.link.id })
          this.urlReady.set(null)
          this.errorMessage.set(null)
        } else if (p.file) {
          this.form.set({ requireAuth: false, password: '', hasExpiry: false, expiresAt: '' })
          this.editIds.set(null)
          this.urlReady.set(null)
          this.errorMessage.set(null)
          // Fetch a fresh UUID eagerly so the URL is ready on submit.
          this.busy.set(true)
          genLinkUuid(this.http).subscribe({
            next: (uuid) => {
              this.pendingUuid.set(uuid)
              this.busy.set(false)
            },
            error: (e: HttpErrorResponse) => {
              this.errorMessage.set(e.error?.message ?? 'Failed to prepare link')
              this.busy.set(false)
            }
          })
        }
      })
    })
  }

  protected passwordPlaceholder(): string {
    if (this.isEdit() && !this.form().password) return '••••••••••'
    return 'Password'
  }

  protected passwordError(): string | null {
    const f = this.form()
    if (!f.requireAuth) return null
    // Edit mode allows leaving password empty (= keep existing). Create requires min length.
    if (this.isEdit() && f.password === '') return null
    if (f.password.length < this.passwordMinLength) return 'v2_link_password_too_short'
    return null
  }

  protected canSubmit(): boolean {
    if (this.busy()) return false
    if (!this.pendingUuid()) return false
    if (this.passwordError()) return false
    if (this.form().hasExpiry && !this.form().expiresAt) return false
    return true
  }

  protected onToggleAuth(ev: Event): void {
    const checked = (ev.target as HTMLInputElement).checked
    this.form.update((s) => ({ ...s, requireAuth: checked, password: checked ? s.password : '' }))
  }

  protected onPasswordInput(ev: Event): void {
    const val = (ev.target as HTMLInputElement).value
    this.form.update((s) => ({ ...s, password: val }))
  }

  protected onToggleExpiry(ev: Event): void {
    const checked = (ev.target as HTMLInputElement).checked
    this.form.update((s) => ({ ...s, hasExpiry: checked, expiresAt: checked ? s.expiresAt : '' }))
  }

  protected onExpiryInput(ev: Event): void {
    const val = (ev.target as HTMLInputElement).value
    this.form.update((s) => ({ ...s, expiresAt: val }))
  }

  protected generate(): void {
    this.form.update((s) => ({ ...s, password: generateLinkPassword() }))
  }

  protected selectAll(ev: Event): void {
    ;(ev.target as HTMLInputElement).select()
  }

  protected submit(): void {
    const p = this.pending()
    if (!p) return
    const uuid = this.pendingUuid()
    if (!uuid) return
    const f = this.form()
    const settings: LinkSettingsInput = {
      uuid,
      requireAuth: f.requireAuth,
      password: f.requireAuth && f.password ? f.password : null,
      expiresAt: f.hasExpiry && f.expiresAt ? new Date(`${f.expiresAt}T00:00:00`) : null,
      isActive: true
    }
    this.busy.set(true)
    this.errorMessage.set(null)

    if (this.isEdit()) {
      const ids = this.editIds()
      if (!ids) return
      updateLinkOnShare(this.http, ids.shareId, ids.linkId, settings).subscribe({
        next: (link: LinkGuest) => {
          this.busy.set(false)
          const url = buildPublicLinkUrl(link.uuid ?? uuid)
          this.urlReady.set(url)
          this.toast.success('v2_link_updated')
          this.service.latch({
            url,
            shareId: ids.shareId,
            password: settings.password,
            expiresAt: settings.expiresAt ?? null,
            requireAuth: settings.requireAuth,
            isActive: settings.isActive
          })
        },
        error: (e: HttpErrorResponse) => {
          this.errorMessage.set(e.error?.message ?? 'Failed to update link')
          this.busy.set(false)
        }
      })
      return
    }

    if (!p.file) return
    createLinkShare(this.http, {
      file: { id: p.file.id, name: p.file.name, isDir: p.file.isDir, mime: p.file.mime, space: p.file.space },
      relativePath: p.relativePath ?? p.file.name,
      ownerId: p.ownerId ?? null,
      settings
    }).subscribe({
      next: (share: ShareProps) => {
        this.busy.set(false)
        const url = buildPublicLinkUrl(uuid)
        this.urlReady.set(url)
        this.toast.success('v2_link_created')
        this.service.latch({
          url,
          shareId: share.id,
          password: settings.password,
          expiresAt: settings.expiresAt ?? null,
          requireAuth: settings.requireAuth,
          isActive: settings.isActive
        })
      },
      error: (e: HttpErrorResponse) => {
        this.errorMessage.set(e.error?.message ?? 'Failed to create link')
        this.busy.set(false)
      }
    })
  }

  protected async copy(url: string): Promise<void> {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(url)
        this.toast.success('v2_link_copied')
        return
      }
    } catch {
      /* fall through */
    }
    // Fallback: use a hidden textarea.
    if (typeof document !== 'undefined') {
      const ta = document.createElement('textarea')
      ta.value = url
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
        this.toast.success('v2_link_copied')
      } catch {
        this.toast.error('v2_link_copy_failed')
      } finally {
        document.body.removeChild(ta)
      }
    }
  }

  protected revoke(): void {
    const ids = this.editIds()
    if (!ids) return
    this.busy.set(true)
    this.errorMessage.set(null)
    deleteLinkShare(this.http, ids.shareId).subscribe({
      next: () => {
        this.busy.set(false)
        this.toast.success('v2_link_revoked')
        this.service.latch({
          url: this.urlReady() ?? '',
          shareId: ids.shareId,
          password: null,
          expiresAt: null,
          requireAuth: false,
          isActive: false,
          revoked: true
        })
        this.service.close()
      },
      error: (e: HttpErrorResponse) => {
        this.errorMessage.set(e.error?.message ?? 'Failed to revoke')
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

  private resetState(): void {
    this.urlReady.set(null)
    this.pendingUuid.set(null)
    this.editIds.set(null)
    this.busy.set(false)
    this.errorMessage.set(null)
    this.form.set({ requireAuth: false, password: '', hasExpiry: false, expiresAt: '' })
  }
}

function toDateInputValue(d: Date | string): string {
  const dt = typeof d === 'string' ? new Date(d) : d
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`)
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
}
