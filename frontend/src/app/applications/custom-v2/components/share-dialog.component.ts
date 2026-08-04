import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, effect, HostListener, inject, signal, untracked } from '@angular/core'
import type { ShareProps } from '@sync-in-server/backend/src/applications/shares/interfaces/share-props.interface'
import { MEMBER_TYPE } from '@sync-in-server/backend/src/applications/users/constants/member'
import { USER_PASSWORD_MIN_LENGTH } from '@sync-in-server/backend/src/applications/users/constants/user'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { StoreService } from '../../../store/store.service'
import { userAvatarUrl } from '../../users/user.functions'
import { IconV2Component } from '../icons/icon-v2.component'
import { buildPublicLinkUrl, createLinkShare, generateLinkPassword, genLinkUuid, getLinkOnShare, type LinkSettingsInput } from '../utils/link-share'
import { mimeToGlyph } from '../utils/mime-to-glyph'
import {
  createShare,
  deleteShare,
  getShare,
  permissionsToPreset,
  type PermissionPreset,
  presetToPermissions,
  type ShareLinkInput,
  type ShareMemberInput,
  updateShare
} from '../utils/share-crud'
import { AvatarComponent, avatarInitials, avatarTone, type AvatarUser } from './avatar.component'
import { ButtonComponent } from './button.component'
import { FileGlyphComponent, type FileGlyphType } from './file-glyph.component'
import { IconButtonComponent } from './icon-button.component'
import { PillComponent } from './pill.component'
import { SelectComponent, type SelectOption } from './select.component'
import { ShareDialogFileCtx, ShareDialogService } from './share-dialog.service'
import { ToastService } from './toast.service'
import { ToggleComponent } from './toggle.component'
import { type PickedMember, UserGroupPickerComponent } from './user-group-picker.component'

interface PersonRow extends ShareMemberInput {
  name: string
  description?: string
  avatar: AvatarUser
  preset: PermissionPreset
}

/** The link's editable state, whether or not it exists on the server yet. */
interface LinkForm {
  requireAuth: boolean
  password: string
  /** ISO yyyy-MM-dd for `<input type="date">`; '' means no expiry. */
  expiresAt: string
  preset: PermissionPreset
}

const EMPTY_FORM: LinkForm = { requireAuth: false, password: '', expiresAt: '', preset: 'viewer' }

/**
 * Sharing — ONE dialog with two zones (D7).
 *
 * People on top, the public link below a divider. It used to be two dialogs, so the
 * two things you can do with a file lived in different places and neither showed the
 * other: a file could carry both and no screen said so.
 *
 * ─── Everything commits on Done. ──────────────────────────────────────────────
 * The design's two-tier destruction rule says a reversible act — revoking a link —
 * should happen immediately with an Undo toast. This dialog deviates, and the reason
 * is the wire: an update is ONE PUT that rebuilds the share's entire member set from
 * the body (`shares-manager.service.ts:267`). An immediate link write followed by a
 * member write is two writes to the same set, and the second reverts the first — the
 * lost update that #439 was three-quarters of. So the link toggle, the link's options
 * and the people rows are all local until Done, and `Revoke link` turns the link off
 * locally with the same commit point.
 *
 * That one PUT expresses all three link outcomes, which is what makes the merge work
 * at all: echo the link back to keep it, omit it to revoke it, or send it with a
 * NEGATIVE id and `linkSettings` to create one. An existing link's settings ride along
 * the same way (id >= 0 WITH settings = "modified").
 *
 * ─── Two rows the design draws that have nothing behind them. ─────────────────
 *  • **Inherited rights** ("group · 5 members · inherited from space"). `ShareProps`
 *    carries the share's OWN members and `Member` has no inherited marker, so nothing
 *    tells this dialog who else reaches the file through its space. A disabled row
 *    would be inventing an access grant.
 *  • **Allow download.** `CreateOrUpdateLinkDto` has uuid, name, email, language,
 *    limitAccess, expiresAt, requireAuth, isActive, permissions and password. There is
 *    no download flag to toggle.
 *
 * The link's Permission row IS real — it is the link member's own permission string,
 * through the same presets a person gets, minus `manage`: the share's re-share
 * permission is about a member acting on the share, and there is nobody behind a URL.
 */
@Component({
  selector: 'app-v2-share-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './share-dialog.component.html',
  styleUrl: './share-dialog.component.scss',
  imports: [
    AvatarComponent,
    ButtonComponent,
    FileGlyphComponent,
    IconButtonComponent,
    IconV2Component,
    PillComponent,
    SelectComponent,
    ToggleComponent,
    UserGroupPickerComponent,
    L10nTranslateDirective,
    L10nTranslatePipe
  ]
})
export class ShareDialogComponent {
  private readonly service = inject(ShareDialogService)
  private readonly http = inject(HttpClient)
  private readonly toast = inject(ToastService)
  private readonly store = inject(StoreService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  protected readonly isAdmin: boolean = this.store.user.getValue()?.isAdmin ?? false
  protected readonly passwordMinLength = USER_PASSWORD_MIN_LENGTH

  protected readonly pending = this.service.pending
  protected readonly isEdit = computed(() => !!this.pending()?.existingShareId)

  protected readonly people = signal<PersonRow[]>([])
  protected readonly staged = signal<PickedMember[]>([])
  protected readonly invitePreset = signal<PermissionPreset>('viewer')
  protected readonly loading = signal(false)
  protected readonly busy = signal(false)
  protected readonly errorMessage = signal<string | null>(null)

  private readonly createCtxs = signal<ShareDialogFileCtx[]>([])
  private readonly editShare = signal<ShareProps | null>(null)

  // `linkOn` is the user's intent; `existingLink` is what the server has. The two
  // differ exactly between a toggle and a save, which is what lets one save decide
  // between create, update and delete.
  protected readonly linkOn = signal(false)
  protected readonly form = signal<LinkForm>({ ...EMPTY_FORM })
  private readonly existingLink = signal<{ memberId: number; linkId: number; uuid: string } | null>(null)
  private readonly reservedUuid = signal<string | null>(null)

  protected readonly minExpiryDate: string = toDateInputValue(new Date(Date.now() + 86_400_000))

  protected readonly subjectName = computed(() => {
    const share = this.editShare()
    if (share) return share.name
    const ctxs = this.createCtxs()
    return ctxs.length === 1 ? ctxs[0].file.name : ''
  })

  protected readonly subjectPath = computed(() => {
    const ctxs = this.createCtxs()
    if (ctxs.length !== 1) return null
    return ctxs[0].relativePath.split('/').slice(0, -1).join('/') || null
  })

  protected readonly isMulti = computed(() => !this.isEdit() && this.createCtxs().length > 1)
  protected readonly multiCount = computed(() => this.createCtxs().length)

  protected readonly glyphType = computed<FileGlyphType>(() => {
    const file = this.editShare()?.file ?? this.createCtxs()[0]?.file
    if (!file) return 'default'
    return file.isDir ? 'folder' : mimeToGlyph(file.mime)
  })

  // The owner, as text — not a control, because the owner cannot be demoted here and a
  // disabled select would imply it could be somewhere. Always the current user: the
  // update endpoint is gated on ownership, so whoever can open this on an existing
  // share owns it, and on a create they are about to.
  protected readonly ownerRow = computed<{ name: string; description?: string; avatar: AvatarUser } | null>(() => {
    const u = this.store.user.getValue()
    if (!u) return null
    const login = u.login ?? ''
    return {
      name: u.fullName || login,
      description: u.email,
      avatar: { initials: avatarInitials(u.fullName || login), tone: avatarTone(login), imageUrl: userAvatarUrl(login) }
    }
  })

  // Counts the ROWS under the heading, which is what the heading is counting. The link
  // is access too, but it is not one of these rows — including it made the count say 2
  // above a list of one.
  protected readonly accessCount = computed(() => this.people().length + (this.ownerRow() ? 1 : 0))

  protected readonly roleOptions = computed<SelectOption<PermissionPreset>[]>(() => [
    { id: 'viewer', label: 'v2_share_preset_viewer' },
    { id: 'editor', label: 'v2_share_preset_editor' },
    { id: 'manager', label: 'v2_share_preset_manager' }
  ])

  protected readonly linkRoleOptions = computed<SelectOption<PermissionPreset>[]>(() => [
    { id: 'viewer', label: 'v2_share_preset_viewer' },
    { id: 'editor', label: 'v2_share_preset_editor' }
  ])

  // Only a link that EXISTS has a URL. A reserved uuid is not a link — showing its URL
  // before the save would hand out an address that 404s.
  protected readonly linkUrl = computed(() => {
    const existing = this.existingLink()
    return existing?.uuid ? buildPublicLinkUrl(existing.uuid) : null
  })

  protected readonly linkLede = computed(() => {
    if (!this.linkOn()) return 'v2_share_link_off_lede'
    return this.form().requireAuth ? 'v2_share_link_password_lede' : 'v2_share_link_open_lede'
  })

  protected readonly canRevokeLink = computed(() => this.linkOn() && !!this.existingLink())

  protected readonly ignoredUserIds = computed(() =>
    [...this.people(), ...this.staged()].filter((m) => m.type === MEMBER_TYPE.USER || m.type === MEMBER_TYPE.GUEST).map((m) => m.id)
  )

  protected readonly ignoredGroupIds = computed(() => [...this.people(), ...this.staged()].filter((m) => this.isGroupType(m.type)).map((m) => m.id))

  constructor() {
    effect(() => {
      const p = this.pending()
      untracked(() => {
        this.reset()
        if (!p) return
        if (p.existingShareId) {
          this.load(p.existingShareId, p.focusLink === true)
          return
        }
        this.createCtxs.set(
          p.files?.length ? p.files : p.file ? [{ file: p.file, relativePath: p.relativePath ?? p.file.name, ownerId: p.ownerId ?? null }] : []
        )
        // "Get link" is this dialog with the link on, not a dialog of its own.
        if (p.focusLink) this.toggleLink(true)
      })
    })
  }

  private load(shareId: number, focusLink = false): void {
    this.loading.set(true)
    this.errorMessage.set(null)
    getShare(this.http, shareId).subscribe({
      next: (share) => {
        this.editShare.set(share)
        const members = share.members ?? []
        this.people.set(
          members
            .filter((m) => !m.linkId)
            .map((m) => ({
              id: m.id,
              type: m.type,
              permissions: m.permissions ?? '',
              name: m.name,
              description: m.description,
              avatar: {
                initials: avatarInitials(m.name),
                tone: avatarTone(m.login ?? m.name),
                imageUrl: m.login ? userAvatarUrl(m.login) : null
              },
              preset: permissionsToPreset(m.permissions)
            }))
        )
        // At most one link per share here. The data model allows several; the design
        // draws one ("the public link"), and a second would need a row list rather than
        // a toggle.
        const link = members.find((m) => !!m.linkId)
        if (link?.linkId) {
          this.existingLink.set({ memberId: link.id, linkId: link.linkId, uuid: '' })
          this.linkOn.set(true)
          this.form.set({ ...EMPTY_FORM, preset: permissionsToPreset(link.permissions) })
          // `GET /shares/:id` gives a link member its `linkId` and NOTHING else about
          // the link — no uuid, no expiry, no requireAuth. So the settings need their
          // own request, which is what classic does from the same place
          // (`links.service.ts:174`). Without it the dialog showed an existing link as
          // if it were about to be created.
          this.loadLinkSettings(shareId, link.linkId)
        }
        // Asked for the link on a share that has none: switch it on, so the dialog
        // opens showing what the caller wanted rather than making them find the toggle.
        if (focusLink && !this.linkOn()) this.toggleLink(true)
        this.loading.set(false)
      },
      error: (e: HttpErrorResponse) => {
        this.errorMessage.set(e.error?.message ?? 'Failed to load share')
        this.loading.set(false)
      }
    })
  }

  private loadLinkSettings(shareId: number, linkId: number): void {
    getLinkOnShare(this.http, shareId, linkId).subscribe({
      next: (l) => {
        this.existingLink.update((cur) => (cur ? { ...cur, uuid: l.uuid ?? '' } : cur))
        this.form.update((f) => ({
          ...f,
          requireAuth: l.requireAuth ?? false,
          expiresAt: l.expiresAt ? toDateInputValue(l.expiresAt) : ''
        }))
      },
      // The link is real either way; without its settings the dialog just cannot show
      // the URL, which is better than refusing to open.
      error: () => undefined
    })
  }

  /* ------------------------------------------------------------------ people */

  protected isGroupType(t: MEMBER_TYPE): boolean {
    return t === MEMBER_TYPE.GROUP || t === MEMBER_TYPE.PGROUP
  }

  protected stage(picked: PickedMember): void {
    this.staged.update((list) => (list.some((s) => s.id === picked.id && s.type === picked.type) ? list : [...list, picked]))
  }

  protected unstage(picked: PickedMember): void {
    this.staged.update((list) => list.filter((s) => !(s.id === picked.id && s.type === picked.type)))
  }

  // Staged chips become access rows at the chosen role. One role for the batch, which
  // is what the select beside the input means; a row's role is editable afterwards.
  protected invite(): void {
    const preset = this.invitePreset()
    const isDir = this.subjectIsDir()
    const rows = this.staged().map<PersonRow>((s) => ({
      id: s.id,
      type: s.type,
      permissions: presetToPermissions(preset, isDir),
      name: s.name,
      description: s.description,
      avatar: { initials: avatarInitials(s.name), tone: avatarTone(s.name), imageUrl: s.avatarUrl ?? null },
      preset
    }))
    this.people.update((list) => [...list, ...rows])
    this.staged.set([])
  }

  protected setPreset(m: PersonRow, preset: PermissionPreset): void {
    const isDir = this.subjectIsDir()
    this.people.update((list) =>
      list.map((x) => (x.id === m.id && x.type === m.type ? { ...x, preset, permissions: presetToPermissions(preset, isDir) } : x))
    )
  }

  protected removePerson(m: PersonRow): void {
    this.people.update((list) => list.filter((x) => !(x.id === m.id && x.type === m.type)))
  }

  /* -------------------------------------------------------------------- link */

  protected toggleLink(on: boolean): void {
    this.linkOn.set(on)
    if (!on) return
    // A uuid must be RESERVED by the server before it can be used, so fetch one the
    // moment the user asks for a link; the save then has nothing left to wait for.
    if (!this.existingLink() && !this.reservedUuid()) {
      genLinkUuid(this.http).subscribe({
        next: (uuid) => this.reservedUuid.set(uuid),
        error: (e: HttpErrorResponse) => this.errorMessage.set(e.error?.message ?? 'Failed to prepare link')
      })
    }
  }

  protected toggleRequireAuth(on: boolean): void {
    this.form.update((f) => ({ ...f, requireAuth: on, password: on ? f.password : '' }))
  }

  protected onPasswordInput(ev: Event): void {
    const v = (ev.target as HTMLInputElement).value
    this.form.update((f) => ({ ...f, password: v }))
  }

  protected generatePassword(): void {
    this.form.update((f) => ({ ...f, password: generateLinkPassword() }))
  }

  protected onExpiryInput(ev: Event): void {
    const v = (ev.target as HTMLInputElement).value
    this.form.update((f) => ({ ...f, expiresAt: v }))
  }

  protected clearExpiry(): void {
    this.form.update((f) => ({ ...f, expiresAt: '' }))
  }

  protected setLinkPreset(preset: PermissionPreset): void {
    this.form.update((f) => ({ ...f, preset }))
  }

  protected passwordPlaceholder(): string {
    // An existing link's password never comes back to the client, so an empty field
    // means "keep it" rather than "there is none".
    return this.existingLink() ? '••••••••••' : 'Password'
  }

  protected passwordError(): string | null {
    const f = this.form()
    if (!this.linkOn() || !f.requireAuth) return null
    if (this.existingLink() && f.password === '') return null
    if (f.password.length < this.passwordMinLength) return 'v2_link_password_too_short'
    return null
  }

  // Local, with the same commit point as everything else — see the class comment.
  protected revokeLink(): void {
    this.linkOn.set(false)
    this.form.set({ ...EMPTY_FORM })
  }

  protected selectAll(ev: Event): void {
    ;(ev.target as HTMLInputElement).select()
  }

  protected async copy(url: string): Promise<void> {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(url)
        this.toast.success('v2_link_copied')
        return
      }
    } catch {
      /* fall through to the textarea path */
    }
    if (typeof document === 'undefined') return
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

  /* -------------------------------------------------------------------- save */

  protected canSave(): boolean {
    if (this.busy() || this.loading()) return false
    if (this.passwordError()) return false
    if (this.linkOn() && !this.existingLink() && !this.reservedUuid()) return false
    // A share with no people and no link is reachable — remove everyone, turn the link
    // off — and it is not a share.
    return this.people().length > 0 || this.linkOn()
  }

  protected save(): void {
    const p = this.pending()
    if (!p) return
    this.busy.set(true)
    this.errorMessage.set(null)
    const members: ShareMemberInput[] = this.people().map((m) => ({ id: m.id, type: m.type, permissions: m.permissions }))
    if (this.isEdit() && p.existingShareId) this.saveEdit(p.existingShareId, members)
    else this.saveCreate(members)
  }

  /**
   * One PUT for people and link together.
   *
   * The three link states the body can express, all of them read by the server from
   * the same array:
   *   keep    — id >= 0, no settings   (unchanged; survives the member rebuild)
   *   change  — id >= 0, with settings (the server updates it)
   *   create  — id < 0,  with settings (the server creates it on this share)
   *   revoke  — absent entirely        (the member rebuild deletes it)
   */
  private saveEdit(shareId: number, members: ShareMemberInput[]): void {
    const existing = this.existingLink()
    const permissions = presetToPermissions(this.form().preset, this.subjectIsDir())
    const links: ShareLinkInput[] = []
    if (this.linkOn()) {
      if (existing) {
        links.push({ id: existing.memberId, linkId: existing.linkId, permissions, settings: this.toLinkSettings(existing.uuid) })
      } else {
        const uuid = this.reservedUuid()
        if (uuid) links.push({ id: -1, linkId: -1, permissions, settings: this.toLinkSettings(uuid) })
      }
    }

    updateShare(this.http, { shareId, name: this.editShare()?.name ?? '', members, links }).subscribe({
      next: () => {
        this.busy.set(false)
        this.toast.success('v2_share_updated')
        this.service.latch({ shareId })
        this.service.close()
      },
      error: (e: HttpErrorResponse) => this.fail(e, 'Failed to save share')
    })
  }

  private saveCreate(members: ShareMemberInput[]): void {
    const ctxs = this.createCtxs()
    if (ctxs.length === 0) {
      this.busy.set(false)
      return
    }
    const uuid = this.reservedUuid()
    // One file with a link is one POST carrying both — the create endpoint takes
    // members and links together. Multi-select never carries a link: one reserved uuid
    // cannot serve N shares, and reserving N of them is a different feature.
    if (ctxs.length === 1 && this.linkOn() && uuid) {
      createLinkShare(this.http, {
        file: ctxs[0].file,
        relativePath: ctxs[0].relativePath,
        ownerId: ctxs[0].ownerId,
        settings: this.toLinkSettings(uuid),
        members,
        linkPermissions: presetToPermissions(this.form().preset, this.subjectIsDir())
      }).subscribe({
        next: (share) => this.finishCreate(share.id),
        error: (e: HttpErrorResponse) => this.fail(e, 'Failed to create share')
      })
      return
    }

    if (ctxs.length === 1) {
      createShare(this.http, { file: ctxs[0].file, relativePath: ctxs[0].relativePath, ownerId: ctxs[0].ownerId, members }).subscribe({
        next: (share) => this.finishCreate(share.id),
        error: (e: HttpErrorResponse) => this.fail(e, 'Failed to create share')
      })
      return
    }

    let firstShareId: number | null = null
    let created = 0
    let failed = 0
    let completed = 0
    for (const ctx of ctxs) {
      createShare(this.http, { file: ctx.file, relativePath: ctx.relativePath, ownerId: ctx.ownerId, members }).subscribe({
        next: (share) => {
          if (firstShareId === null) firstShareId = share.id
          created += 1
          completed += 1
          if (completed === ctxs.length) this.finishMulti(firstShareId, created, failed)
        },
        error: () => {
          failed += 1
          completed += 1
          if (completed === ctxs.length) this.finishMulti(firstShareId, created, failed)
        }
      })
    }
  }

  private finishCreate(shareId: number): void {
    this.busy.set(false)
    this.toast.success('v2_share_created')
    this.service.latch({ shareId })
    this.service.close()
  }

  private finishMulti(firstShareId: number | null, created: number, failed: number): void {
    this.busy.set(false)
    if (created === 0) {
      this.errorMessage.set('Failed to create any share')
      return
    }
    if (failed > 0) this.toast.error('v2_share_n_partial_fail', { created, failed })
    else if (created === 1) this.toast.success('v2_share_created')
    else this.toast.success('v2_share_n_created', { nb: created })
    this.service.latch({ shareId: firstShareId ?? 0, multi: { created, failed } })
    this.service.close()
  }

  protected revokeShare(): void {
    const p = this.pending()
    if (!p?.existingShareId) return
    const shareId = p.existingShareId
    this.busy.set(true)
    this.errorMessage.set(null)
    deleteShare(this.http, shareId).subscribe({
      next: () => {
        this.busy.set(false)
        this.toast.success('v2_share_revoked')
        this.service.latch({ shareId, revoked: true })
        this.service.close()
      },
      error: (e: HttpErrorResponse) => this.fail(e, 'Failed to revoke share')
    })
  }

  protected close(): void {
    this.service.close()
  }

  @HostListener('window:keydown.escape')
  onEscape(): void {
    if (this.pending()) this.close()
  }

  /* ------------------------------------------------------------------- utils */

  private toLinkSettings(uuid: string): LinkSettingsInput {
    const f = this.form()
    return {
      uuid,
      requireAuth: f.requireAuth,
      password: f.requireAuth && f.password ? f.password : null,
      expiresAt: f.expiresAt ? new Date(`${f.expiresAt}T00:00:00`) : null,
      isActive: true,
      name: this.subjectName()
    }
  }

  private subjectIsDir(): boolean {
    const ctxs = this.createCtxs()
    if (ctxs.length > 0) return !!ctxs[0].file.isDir
    return !!this.editShare()?.file?.isDir
  }

  private fail(e: HttpErrorResponse, fallback: string): void {
    this.errorMessage.set(e.error?.message ?? fallback)
    this.busy.set(false)
  }

  private reset(): void {
    this.people.set([])
    this.staged.set([])
    this.invitePreset.set('viewer')
    this.createCtxs.set([])
    this.editShare.set(null)
    this.linkOn.set(false)
    this.form.set({ ...EMPTY_FORM })
    this.existingLink.set(null)
    this.reservedUuid.set(null)
    this.loading.set(false)
    this.busy.set(false)
    this.errorMessage.set(null)
  }
}

function toDateInputValue(d: Date | string): string {
  const dt = typeof d === 'string' ? new Date(d) : d
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`)
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
}
