import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { ActivatedRoute, Router } from '@angular/router'
import type { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { API_SHARES_LINKS_LIST, API_SHARES_LIST } from '@sync-in-server/backend/src/applications/shares/constants/routes'
import type { ShareFile } from '@sync-in-server/backend/src/applications/shares/interfaces/share-file.interface'
import type { ShareLink } from '@sync-in-server/backend/src/applications/shares/interfaces/share-link.interface'
import type { ShareProps } from '@sync-in-server/backend/src/applications/shares/interfaces/share-props.interface'
import { API_SPACES_BROWSE } from '@sync-in-server/backend/src/applications/spaces/constants/routes'
import { SPACE_REPOSITORY } from '@sync-in-server/backend/src/applications/spaces/constants/spaces'
import type { SpaceFiles } from '@sync-in-server/backend/src/applications/spaces/interfaces/space-files.interface'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { catchError, forkJoin, map, Observable, of, Subscription, switchMap } from 'rxjs'
import { SPACES_PATH } from '../../../spaces/spaces.constants'
import { EmptyStateComponent } from '../../components/empty-state.component'
import { FileGlyphComponent } from '../../components/file-glyph.component'
import { IconButtonComponent } from '../../components/icon-button.component'
import { ShareDialogService } from '../../components/share-dialog.service'
import { TimestampComponent } from '../../components/timestamp.component'
import { ToastService } from '../../components/toast.service'
import { IconV2Name } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { InspectorService } from '../../layout/inspector.service'
import { suspendUiVersion } from '../../ui-version'
import { mimeToGlyph } from '../../utils/mime-to-glyph'
import { getShare } from '../../utils/share-crud'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'

export type SharedVariant = 'with-me' | 'with-others' | 'via-links'

// A defensive read of a list response: a body that is not an array (an error page,
// an envelope) becomes an empty listing rather than a TypeError in the map below.
function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : []
}

/**
 * One line of the Shared list, whichever tab produced it.
 *
 * The three tabs read DIFFERENT server collections — not three filters over one
 * (issues #429 / #430). `/api/app/shares/list` is scoped to shares you OWN and to
 * `SHARE_TYPE.COMMON`, so an incoming share is absent from it by construction and
 * no client-side predicate can bring it back.
 *
 * "Via links" reads TWO collections, because a share carrying a public link can be
 * either type. See `loadViaLinks`.
 */
export interface SharedRow {
  /** Stable row identity; unique across a listing (a share may own several links). */
  key: string
  /** The share the row editor acts on; 0 when the row is not an editable share of ours. */
  shareId: number
  name: string
  description: string
  mime: string
  isDir: boolean
  /** Whatever the variant's third column dates — see `whenLabel`. */
  when: number | string | Date | null
  users: number
  groups: number
  links: number
  /** Second column when it is plain data rather than a count (owner, link name). */
  secondary: string
  /** Share alias — how the classic shares browser addresses this share. */
  alias: string
  /** Repository-qualified path for the v2 file screen; '' when not addressable there. */
  filePath: string
}

interface VariantConfig {
  title: string
  icon: IconV2Name
  emptyState: string
  /** Column 2 heading. */
  secondaryLabel: string
  /** Column 3 heading — the three tabs date three different things. */
  whenLabel: string
}

const CONFIGS: Record<SharedVariant, VariantConfig> = {
  'with-me': {
    title: 'With me',
    icon: 'person',
    emptyState: 'Nothing has been shared with you yet.',
    secondaryLabel: 'Shared by',
    whenLabel: 'Modified'
  },
  'with-others': {
    title: 'With others',
    icon: 'arrowUp',
    emptyState: "You haven't shared anything yet.",
    secondaryLabel: 'Recipients',
    whenLabel: 'Modified'
  },
  'via-links': {
    title: 'Via links',
    icon: 'link',
    emptyState: 'No link shares yet.',
    secondaryLabel: 'Link',
    whenLabel: 'Accessed'
  }
}

@Component({
  selector: 'app-v2-shared',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './shared.component.html',
  styleUrl: './shared.component.scss',
  imports: [IconButtonComponent, FileGlyphComponent, TimestampComponent, L10nTranslateDirective, L10nTranslatePipe, EmptyStateComponent]
})
export class SharedComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient)
  private readonly route = inject(ActivatedRoute)
  private readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  private readonly inspector = inject(InspectorService)
  private readonly shareDialog = inject(ShareDialogService)
  private readonly toast = inject(ToastService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private subscription: Subscription | null = null

  // One instant for every row's timestamp — see the same note in recents.
  protected readonly renderedAt = Date.now()

  protected readonly mimeToGlyph = mimeToGlyph
  protected readonly rows = signal<SharedRow[]>([])
  protected readonly loading = signal(true)
  protected readonly errorMessage = signal<string | null>(null)

  protected readonly data = toSignal(this.route.data)

  protected readonly variant = computed<SharedVariant>(() => {
    const v = (this.data() as { variant?: SharedVariant } | undefined)?.variant
    return v ?? 'with-me'
  })

  protected readonly config = computed<VariantConfig>(() => CONFIGS[this.variant()])

  ngOnInit(): void {
    // Shared rows act as direct links (click → open) — there's no
    // single-row selection state for the dock panel to read against.
    // Leave the inspector unavailable so the top bar hides its toggle instead of
    // surfacing tabs that resolve to "Select a file…" empty states.
    this.inspector.clear()
    this.breadcrumbs.setBreadcrumbs([
      { label: 'Shared', icon: 'share' },
      { label: CONFIGS[this.variant()].title, icon: CONFIGS[this.variant()].icon }
    ])
    this.refresh()
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe()
    this.inspector.clear()
  }

  protected refresh(): void {
    this.loading.set(true)
    this.errorMessage.set(null)
    this.subscription?.unsubscribe()
    this.subscription = this.load(this.variant()).subscribe({
      next: (rows: SharedRow[]) => {
        this.rows.set(rows)
        this.loading.set(false)
      },
      error: (e: HttpErrorResponse) => {
        // Logged with the tab that failed, because the three tabs hit different
        // endpoints and a bare `console.error(e)` said nothing about which. No
        // toast: the failure already renders in place (`errorMessage`), and this
        // screen has a Refresh button next to it.
        console.error(`v2 shared: "${this.variant()}" failed to load`, e)
        this.rows.set([])
        this.errorMessage.set('Failed to load shares.')
        this.loading.set(false)
      }
    })
  }

  private load(variant: SharedVariant): Observable<SharedRow[]> {
    if (variant === 'with-me') {
      // Incoming shares are NOT in `/api/app/shares/list` — they live in the shares
      // REPOSITORY, whose root listing is one entry per share made to this account.
      // Same source the classic `spaces/shares` screen browses.
      return this.http
        .get<SpaceFiles>(`${API_SPACES_BROWSE}/${SPACE_REPOSITORY.SHARES}`)
        .pipe(map((result: SpaceFiles) => this.rowsFromSharesRepository(asArray(result?.files))))
    }
    if (variant === 'via-links') {
      return this.loadViaLinks()
    }
    return this.http.get<ShareFile[]>(API_SHARES_LIST).pipe(map((shares: ShareFile[]) => this.rowsFromShares(asArray(shares))))
  }

  /**
   * Every share of mine that carries a public link — from BOTH collections that can
   * hold one.
   *
   * `shares.type` is a whole-share discriminator and the two list endpoints partition
   * on it: `links/list` pins `SHARE_TYPE.LINK` (`shares-queries.service.ts:205`) and
   * `shares/list` pins `SHARE_TYPE.COMMON` (`:529`). Classic puts a share in the first
   * bucket only when it was created BY the link dialog, which sets `type` explicitly
   * (`link-dialog.component.ts:197`); a link added to an existing share from the
   * classic share dialog's Links tab lands in the second and never shows on classic's
   * own Links screen.
   *
   * v2 is always in the second bucket. Its share dialog is merged — ONE share holds
   * both people and links — so it posts no `type` at all and the server defaults it to
   * COMMON (`shares-manager.service.ts:136`). Stamping LINK on it instead would be
   * worse than this bug: the same share would vanish from "With others" and from
   * classic's Shares screen, and it would drop out of content indexing, which also
   * filters on COMMON (`files-content-parser.service.ts:129`). A share with people AND
   * a link has no correct value for a field that only says "people" or "link".
   *
   * So the tab unions the two, which needs no migration for the shares v2 has already
   * created. The two are disjoint by construction (the type filters are complementary),
   * so there is nothing to de-duplicate.
   *
   * `shares/list` reports only a COUNT of link members, so the link's own name comes
   * from `GET /shares/:id`, whose members carry `linkId` and the link name
   * (`shares-queries.service.ts:271-280`) — one request per share that has a link, none
   * when none does.
   */
  private loadViaLinks(): Observable<SharedRow[]> {
    return forkJoin({
      links: this.http.get<ShareLink[]>(API_SHARES_LINKS_LIST),
      shares: this.http.get<ShareFile[]>(API_SHARES_LIST)
    }).pipe(
      switchMap(({ links, shares }: { links: ShareLink[]; shares: ShareFile[] }) => {
        const linkRows: SharedRow[] = this.rowsFromShareLinks(asArray(links))
        const withLinks: ShareFile[] = asArray(shares).filter((s: ShareFile) => (s.counts?.links ?? 0) > 0)
        if (!withLinks.length) return of(linkRows)
        return forkJoin(withLinks.map((s: ShareFile) => getShare(this.http, s.id).pipe(catchError(() => of(null as ShareProps | null))))).pipe(
          map((details: (ShareProps | null)[]) => [
            ...linkRows,
            ...withLinks.flatMap((s: ShareFile, i: number) => this.rowsFromCommonShareLinks(s, details[i]))
          ])
        )
      }),
      // One tab, one ordering. Sorted by name only, and Array#sort is stable, so the
      // several links of one share keep the order their source returned them in.
      map((rows: SharedRow[]) => [...rows].sort((a, b) => a.name.localeCompare(b.name)))
    )
  }

  // Outgoing shares, exactly as classic's Shared screen lists them: every row the
  // endpoint returns. It used to drop rows with a `parent` to fake a "with me" tab;
  // those are re-shares the user OWNS (a share created inside a share they received),
  // so hiding them here hid them everywhere.
  private rowsFromShares(shares: ShareFile[]): SharedRow[] {
    return shares.map((s: ShareFile) => ({
      key: `share-${s.id}`,
      shareId: s.id,
      name: s.name,
      description: s.description ?? '',
      mime: s.file?.mime ?? '',
      isDir: s.file?.isDir ?? !s.file?.id,
      when: s.modifiedAt ?? null,
      users: s.counts?.users ?? 0,
      groups: s.counts?.groups ?? 0,
      links: s.counts?.links ?? 0,
      secondary: '',
      alias: s.alias ?? '',
      filePath: ''
    }))
  }

  private rowsFromShareLinks(links: ShareLink[]): SharedRow[] {
    return links.map((s: ShareLink) => ({
      // Keyed on the LINK, not the share: one share can carry several links and
      // each is its own row here, the same way classic's Links screen lists them.
      key: `link-${s.link?.id ?? s.id}`,
      shareId: s.id,
      name: s.name,
      description: s.description ?? '',
      mime: s.file?.mime ?? '',
      isDir: s.file?.isDir ?? !s.file?.id,
      // Links have no modifiedAt; what a link owner watches is when it was last used.
      when: s.link?.currentAccess ?? null,
      users: 0,
      groups: 0,
      links: 1,
      secondary: s.link?.name ?? '',
      alias: s.alias ?? '',
      filePath: ''
    }))
  }

  /**
   * One COMMON share that carries at least one link — the shape every link v2
   * creates has. See `loadViaLinks` for why they are COMMON.
   *
   * `detail` is null when the per-share lookup failed. The share still gets a row
   * then: a row with an empty Link column is recoverable (its editor opens and shows
   * the link), a missing row is the bug being fixed.
   */
  private rowsFromCommonShareLinks(share: ShareFile, detail: ShareProps | null): SharedRow[] {
    const linkMembers = (detail?.members ?? []).filter((m: { linkId?: number }) => !!m.linkId)
    if (!linkMembers.length) {
      return [{ ...this.commonLinkRow(share), key: `share-${share.id}-links`, links: share.counts?.links ?? 1 }]
    }
    return linkMembers.map((m: { linkId?: number; name?: string }) => ({
      ...this.commonLinkRow(share),
      key: `link-${m.linkId}`,
      secondary: m.name ?? ''
    }))
  }

  private commonLinkRow(share: ShareFile): SharedRow {
    return {
      key: '',
      shareId: share.id,
      name: share.name,
      description: share.description ?? '',
      mime: share.file?.mime ?? '',
      isDir: share.file?.isDir ?? !share.file?.id,
      // Deliberately blank. `/shares/list` carries no link access time, and fetching
      // one per link would be a second round trip per row; printing the share's
      // `modifiedAt` under an "Accessed" heading would be worse than printing nothing.
      when: null,
      users: 0,
      groups: 0,
      links: 1,
      secondary: '',
      alias: share.alias ?? '',
      filePath: ''
    }
  }

  private rowsFromSharesRepository(files: FileProps[]): SharedRow[] {
    return files.map((f: FileProps) => ({
      // The shares repository root has one entry per incoming share, so the file id
      // is unique within the listing. There is no share id here: the recipient does
      // not own the share and cannot open the share editor on it.
      key: `incoming-${f.id}`,
      shareId: 0,
      name: f.name,
      description: f.root?.description ?? '',
      mime: f.mime ?? '',
      isDir: f.isDir,
      when: f.mtime ?? null,
      users: 0,
      groups: 0,
      links: 0,
      secondary: f.root?.owner?.fullName || f.root?.owner?.login || '',
      alias: f.root?.alias ?? '',
      // A shared FILE is addressable by the v2 file screen — by its share ALIAS, not
      // its name (#429). `spaceEnv(['shares', <segment>])` resolves the segment through
      // `sharesManager.permissions(user, spaceAlias)`, i.e. `shares.alias`, and an alias
      // is a slug (`uniqueShareAlias` → `createSlug`), so "Sync engine notes.md" never
      // matches `sync-engine-notes-md`. Classic addresses a root entry the same way:
      // `root?.alias || name` (files/models/file.model.ts:93). Its other half is in
      // `file-detail.component.ts::loadFile`, which must resolve the listing row by the
      // same convention — the browse response names the row after the SHARE.
      filePath: f.isDir ? '' : [SPACE_REPOSITORY.SHARES, f.root?.alias || f.name].join('/')
    }))
  }

  protected openRow(row: SharedRow): void {
    if (this.variant() === 'via-links') {
      this.openLinkEditor(row)
      return
    }
    if (this.variant() === 'with-others') {
      this.openShareEditor(row)
      return
    }
    this.openIncoming(row)
  }

  private openIncoming(row: SharedRow): void {
    if (row.filePath) {
      this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: { path: row.filePath } }).catch(console.error)
      return
    }
    if (!row.alias) {
      // Not reachable from a well-formed listing — every shares-repository entry has a
      // root alias — but a silent `return` on a row the user just clicked is the worst
      // possible answer, so say so rather than doing nothing.
      this.toast.error('This share cannot be opened')
      console.error('v2 shared: incoming row has neither a file path nor a share alias', row)
      return
    }
    // v2 has no browser for the shares repository yet, so a shared FOLDER hands off to
    // the classic one. uiVersionGuard bounces every classic URL back to /v2 while
    // `ui.version` says 'v2', so the hand-off has to get past it — but it no longer
    // CLEARS the preference. Clearing it ejected the user from v2 for good over one
    // folder click; `suspendUiVersion()` stands the guard down for this browser tab
    // only, and reaching any /v2 route lifts the suspension again.
    suspendUiVersion()
    this.toast.info('Opening the classic interface')
    this.router.navigate([`/${SPACES_PATH.SPACES_SHARES}`, row.alias]).catch(console.error)
  }

  private async openShareEditor(row: SharedRow): Promise<void> {
    const result = await this.shareDialog.open({ existingShareId: row.shareId })
    if (result?.revoked) this.refresh()
  }

  // A link share is a share, and sharing is one dialog now — so this opens the same
  // editor the "with others" rows do. The dialog loads the share itself, which also
  // means it shows the PEOPLE on a link share, something the link dialog could not.
  private async openLinkEditor(row: SharedRow): Promise<void> {
    const result = await this.shareDialog.open({ existingShareId: row.shareId, focusLink: true })
    if (result?.revoked) this.refresh()
  }

  protected recipientCount(row: SharedRow): number {
    return row.users + row.groups
  }
}
