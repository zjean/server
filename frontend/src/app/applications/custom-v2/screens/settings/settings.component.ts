import { HttpErrorResponse, HttpHeaders } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, ElementRef, inject, OnInit, signal, ViewChild } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { toSignal } from '@angular/core/rxjs-interop'
import { Router } from '@angular/router'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { USER_PASSWORD_MIN_LENGTH } from '@sync-in-server/backend/src/applications/users/constants/user'
import { APP_VERSION } from '../../../../app.constants'
import { ToBytesPipe } from '../../../../common/pipes/to-bytes.pipe'
import { StoreService } from '../../../../store/store.service'
import { USER_LANGUAGE_AUTO, USER_ONLINE_STATUS_LIST } from '../../../users/user.constants'
import { UserService } from '../../../users/user.service'
import { LayoutService } from '../../../../layout/layout.service'
import { i18nLanguageText } from '../../../../../i18n/l10n'
import { ButtonComponent } from '../../components/button.component'
import { ToastService } from '../../components/toast.service'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'

@Component({
  selector: 'app-v2-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
  imports: [ButtonComponent, FormsModule, ToBytesPipe, L10nTranslateDirective, L10nTranslatePipe]
})
export class SettingsComponent implements OnInit {
  private readonly store = inject(StoreService)
  private readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  private readonly userService = inject(UserService)
  private readonly layout = inject(LayoutService)
  private readonly toast = inject(ToastService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  @ViewChild('avatarInput') private avatarInput?: ElementRef<HTMLInputElement>

  protected readonly user = toSignal(this.store.user)
  protected readonly userAvatar = toSignal(this.store.userAvatarUrl)
  protected readonly version = APP_VERSION
  protected readonly passwordMinLength = USER_PASSWORD_MIN_LENGTH
  protected readonly languages = this.layout.getLanguages(true)
  protected readonly languageLabels = i18nLanguageText
  protected readonly onlineStatuses = USER_ONLINE_STATUS_LIST

  protected readonly language = signal<string>(USER_LANGUAGE_AUTO)
  protected readonly savingLanguage = signal(false)
  protected readonly onlineStatus = signal<number>(0)

  protected readonly oldPassword = signal('')
  protected readonly newPassword = signal('')
  protected readonly confirmPassword = signal('')
  protected readonly savingPassword = signal(false)

  protected readonly canSavePassword = computed(
    () => this.oldPassword().length > 0 && this.newPassword().length >= this.passwordMinLength && this.newPassword() === this.confirmPassword()
  )

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

  protected savePassword(): void {
    if (!this.canSavePassword()) return
    this.savingPassword.set(true)
    const headers = new HttpHeaders()
    this.userService.changePassword({ oldPassword: this.oldPassword(), newPassword: this.newPassword() }, headers).subscribe({
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
}
