import { HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, ElementRef, inject, OnInit, signal, ViewChild } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { toSignal } from '@angular/core/rxjs-interop'
import { Router } from '@angular/router'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { COLLABORA_APP_LOCK } from '@sync-in-server/backend/src/applications/files/editors/collabora-online/collabora-online.constants'
import type { FileEditorProviders } from '@sync-in-server/backend/src/applications/files/editors/file-editor-providers.interface'
import { EURO_OFFICE_APP_LOCK, ONLY_OFFICE_APP_LOCK } from '@sync-in-server/backend/src/applications/files/editors/only-office/only-office.constants'
import { USER_PASSWORD_MIN_LENGTH } from '@sync-in-server/backend/src/applications/users/constants/user'
import { WEBDAV_BASE_PATH } from '@sync-in-server/backend/src/applications/webdav/constants/routes'
import { APP_VERSION } from '../../../../app.constants'
import { ToBytesPipe } from '../../../../common/pipes/to-bytes.pipe'
import { StoreService } from '../../../../store/store.service'
import { USER_LANGUAGE_AUTO, USER_NOTIFICATION_TEXT, USER_ONLINE_STATUS_LIST } from '../../../users/user.constants'
import { UserService } from '../../../users/user.service'
import { LayoutService } from '../../../../layout/layout.service'
import { i18nLanguageText } from '../../../../../i18n/l10n'
import { ButtonComponent } from '../../components/button.component'
import { ToastService } from '../../components/toast.service'
import { TwoFaDialogService } from '../../components/two-fa-dialog.service'
import { IconV2Component } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'

@Component({
  selector: 'app-v2-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
  imports: [ButtonComponent, FormsModule, IconV2Component, ToBytesPipe, L10nTranslateDirective, L10nTranslatePipe]
})
export class SettingsComponent implements OnInit {
  private readonly store = inject(StoreService)
  private readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  private readonly userService = inject(UserService)
  private readonly layout = inject(LayoutService)
  private readonly toast = inject(ToastService)
  private readonly twoFa = inject(TwoFaDialogService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  @ViewChild('avatarInput') private avatarInput?: ElementRef<HTMLInputElement>

  protected readonly user = toSignal(this.store.user)
  protected readonly userAvatar = toSignal(this.store.userAvatarUrl)
  protected readonly version = APP_VERSION
  protected readonly passwordMinLength = USER_PASSWORD_MIN_LENGTH
  protected readonly languages = this.layout.getLanguages(true)
  protected readonly languageLabels = i18nLanguageText
  protected readonly onlineStatuses = USER_ONLINE_STATUS_LIST
  // Index in this array IS the wire value (`USER_NOTIFICATION`): 0 = application,
  // 1 = application and email. Classic derives it the same way with
  // `allNotifications.indexOf(n)` — it is a number, never a boolean.
  protected readonly notifications = Object.values(USER_NOTIFICATION_TEXT)
  protected readonly webdavUrl = typeof window === 'undefined' ? '' : `${window.location.origin}/${WEBDAV_BASE_PATH}`

  protected readonly language = signal<string>(USER_LANGUAGE_AUTO)
  protected readonly savingLanguage = signal(false)
  protected readonly onlineStatus = signal<number>(0)
  protected readonly notification = signal<number>(0)
  protected readonly storageIndexing = signal(false)
  protected readonly editorPreference = signal<keyof FileEditorProviders | null>(null)

  protected readonly oldPassword = signal('')
  protected readonly newPassword = signal('')
  protected readonly confirmPassword = signal('')
  protected readonly savingPassword = signal(false)

  protected readonly canSavePassword = computed(
    () => this.oldPassword().length > 0 && this.newPassword().length >= this.passwordMinLength && this.newPassword() === this.confirmPassword()
  )

  // Same gate as classic (`user-account.component.ts:88`): a preference only has
  // meaning when Collabora AND one of the OnlyOffice-family editors are both
  // configured, because that is the only case where two editors claim the same
  // file type. The office slot is one editor, not two — `onlyoffice` wins the
  // label and the provider key when both flags are on, exactly as classic's
  // `editors` getter does.
  protected readonly editorOptions = computed<{ label: string; value: keyof FileEditorProviders }[]>(() => {
    const editors = this.store.server().files.editors
    if (!editors.collabora || !(editors.onlyoffice || editors.eurooffice)) return []
    return [
      { label: COLLABORA_APP_LOCK, value: 'collabora' },
      { label: editors.onlyoffice ? ONLY_OFFICE_APP_LOCK : EURO_OFFICE_APP_LOCK, value: editors.onlyoffice ? 'onlyoffice' : 'eurooffice' }
    ]
  })

  protected readonly showEditorPreference = computed(() => this.editorOptions().length > 0)

  protected readonly initials = computed(() => {
    const u = this.user()
    if (!u) return '?'
    const parts = (u.fullName || u.login || '').trim().split(/\s+/).filter(Boolean)
    return (
      parts
        .slice(0, 2)
        .map((p) => p[0])
        .join('')
        .toUpperCase() || '?'
    )
  })

  protected readonly storagePercent = computed(() => {
    const u = this.user()
    if (!u?.storageQuota || u.storageQuota <= 0) return 0
    return Math.min(100, Math.round(((u.storageUsage ?? 0) / u.storageQuota) * 100))
  })

  ngOnInit(): void {
    this.breadcrumbs.setBreadcrumbs([{ label: 'Settings', icon: 'settings' }])
    const u = this.user()
    if (u) {
      this.language.set(u.language ?? USER_LANGUAGE_AUTO)
      this.onlineStatus.set(u.onlineStatus ?? 0)
      this.notification.set(u.notification ?? 0)
      this.storageIndexing.set(!!u.storageIndexing)
    }
    if (this.showEditorPreference()) {
      // Validate before binding, like classic does: the stored value is raw
      // localStorage and may name an editor this server no longer offers. An
      // unknown value falls back to null ("Ask Me").
      const stored = this.readEditorPreference()
      const known = this.editorOptions().some((o) => o.value === stored)
      this.editorPreference.set(known ? stored : null)
    }
  }

  protected saveLanguage(): void {
    const lang = this.language()
    this.savingLanguage.set(true)
    this.userService.changeLanguage({ language: lang }).subscribe({
      next: () => {
        this.savingLanguage.set(false)
        this.layout.setLanguage(lang).catch(console.error)
        const u = this.store.user.getValue()
        if (u) this.store.user.next({ ...u, language: lang })
        this.toast.success('Language updated')
      },
      error: (e: HttpErrorResponse) => {
        this.savingLanguage.set(false)
        this.toast.error(e.error?.message ?? 'Unable to update language')
      }
    })
  }

  protected triggerAvatarPicker(): void {
    const input = this.avatarInput?.nativeElement
    if (!input) return
    input.value = ''
    input.click()
  }

  protected onAvatarPicked(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0]
    if (!file) return
    this.userService.uploadAvatar(file).subscribe({
      next: () => this.toast.success('Avatar uploaded'),
      error: (e: HttpErrorResponse) => this.toast.error(e.error?.message ?? 'Unable to upload avatar')
    })
  }

  protected regenerateAvatar(): void {
    this.userService.genAvatar().subscribe({
      next: () => this.toast.success('Avatar regenerated'),
      error: (e: HttpErrorResponse) => this.toast.error(e.error?.message ?? 'Unable to regenerate avatar')
    })
  }

  protected async savePassword(): Promise<void> {
    if (!this.canSavePassword()) return
    // Three-state, mirroring classic (`user-account.component.ts:150`):
    //   false     -> the user closed the dialog; abandon the change
    //   undefined -> no verification needed; send the request WITHOUT headers
    //   HttpHeaders -> the TOTP / password to verify, passed straight through
    // `if (!headers) return` would collapse the last two and break password
    // changes for every user who does not have 2FA enabled.
    const twoFaHeaders = await this.twoFa.verify(false)
    if (twoFaHeaders === false) return
    this.savingPassword.set(true)
    this.userService.changePassword({ oldPassword: this.oldPassword(), newPassword: this.newPassword() }, twoFaHeaders).subscribe({
      next: () => {
        this.savingPassword.set(false)
        this.oldPassword.set('')
        this.newPassword.set('')
        this.confirmPassword.set('')
        this.toast.success('Password updated')
      },
      error: (e: HttpErrorResponse) => {
        this.savingPassword.set(false)
        this.toast.error(e.error?.message ?? 'Unable to update password')
      }
    })
  }

  protected saveOnlineStatus(): void {
    const status = this.onlineStatus()
    this.userService.changeOnlineStatus(status, true)
    const u = this.store.user.getValue()
    if (u) this.store.user.next({ ...u, onlineStatus: status })
    this.toast.success('Status updated')
  }

  protected statusLabel(idx: number): string {
    const name = this.onlineStatuses[idx] ?? 'offline'
    return name.charAt(0).toUpperCase() + name.slice(1)
  }

  protected updateNotification(status: number): void {
    const previous = this.notification()
    this.notification.set(status)
    this.userService.changeNotification({ notification: status }).subscribe({
      next: () => {
        const u = this.store.user.getValue()
        if (u) this.store.user.next({ ...u, notification: status })
        this.toast.success('Notification preference updated')
      },
      error: (e: HttpErrorResponse) => {
        this.notification.set(previous)
        this.toast.error(e.error?.message ?? 'Unable to update notification preference')
      }
    })
  }

  protected updateStorageIndexing(enabled: boolean): void {
    const previous = this.storageIndexing()
    this.storageIndexing.set(enabled)
    this.userService.changeStorageIndexing({ storageIndexing: enabled }).subscribe({
      next: () => {
        const u = this.store.user.getValue()
        if (u) this.store.user.next({ ...u, storageIndexing: enabled })
        // Classic's wording: the user-facing name is "full-text search", not
        // "indexing" — the DTO field is the only place "indexing" appears.
        this.toast.success('Full-text search preference updated')
      },
      error: (e: HttpErrorResponse) => {
        this.storageIndexing.set(previous)
        this.toast.error(e.error?.message ?? 'Unable to update full-text search preference')
      }
    })
  }

  protected updateEditorPreference(preference: keyof FileEditorProviders | null): void {
    // Local only: `setEditorProviderPreference` writes localStorage and returns
    // void — there is no endpoint and nothing to subscribe to.
    this.editorPreference.set(preference)
    this.userService.setEditorProviderPreference(preference)
    this.toast.success('Editor preference updated')
  }

  protected async copyWebdavUrl(): Promise<void> {
    const url = this.webdavUrl
    if (!url) return
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(url)
        this.toast.success('v2_link_copied')
        return
      }
    } catch {
      /* fall through to the textarea fallback */
    }
    if (typeof document === 'undefined') {
      this.toast.error('v2_link_copy_failed')
      return
    }
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
      ta.remove()
    }
  }

  private readEditorPreference(): keyof FileEditorProviders | null {
    // SSR / test guard: `getEditorProviderPreference` reads localStorage directly.
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return null
    return this.userService.getEditorProviderPreference() ?? null
  }
}
