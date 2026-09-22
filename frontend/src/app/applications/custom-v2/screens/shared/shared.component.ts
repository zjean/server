import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { ActivatedRoute, Router } from '@angular/router'
import type { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { API_SHARES_LINKS_LIST, API_SHARES_LIST } from '@sync-in-server/backend/src/applications/shares/constants/routes'
import type { ShareFile } from '@sync-in-server/backend/src/applications/shares/interfaces/share-file.interface'
import type { ShareLink } from '@sync-in-server/backend/src/applications/shares/interfaces/share-link.interface'
import { API_SPACES_BROWSE } from '@sync-in-server/backend/src/applications/spaces/constants/routes'
import { SPACE_REPOSITORY } from '@sync-in-server/backend/src/applications/spaces/constants/spaces'
import type { SpaceFiles } from '@sync-in-server/backend/src/applications/spaces/interfaces/space-files.interface'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { map, Observable, Subscription } from 'rxjs'
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
import { clearUiVersion } from '../../ui-version'
import { mimeToGlyph } from '../../utils/mime-to-glyph'
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
 * The three tabs are three DIFFERENT server collections — not three filters over
 * one (issues #429 / #430). `/api/app/shares/list` is scoped to shares you OWN and
 * to `SHARE_TYPE.COMMON`, so an incoming share and a public link are both absent
 * from it by construction and no client-side predicate can bring them back. Each
 * variant therefore has its own endpoint and its own mapper into this shape.
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
        console.error(e)
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
        .pipe(map((result: SpaceFiles) => this.rowsFromSharesRepository(Array.isArray(result?.files) ? result.files : [])))
    }
    if (variant === 'via-links') {
      // A public link is a SHARE_TYPE.LINK share, which the common list excludes
      // server-side; `links/list` is the endpoint classic's Links screen uses.
      return this.http.get<ShareLink[]>(API_SHARES_LINKS_LIST).pipe(map((links: ShareLink[]) => this.rowsFromShareLinks(asArray(links))))
    }
    return this.http.get<ShareFile[]>(API_SHARES_LIST).pipe(map((shares: ShareFile[]) => this.rowsFromShares(asArray(shares))))
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
      // A shared FILE is addressable by the v2 file screen, which browses the
      // parent and matches by name — `shares` is exactly the listing above.
      filePath: f.isDir ? '' : [SPACE_REPOSITORY.SHARES, f.name].join('/')
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
    if (!row.alias) return
    // v2 has no browser for the shares repository yet, so a shared FOLDER hands off
    // to the classic one — the same hand-off the v2 placeholder screens make. It has
    // to clear `ui.version` first: uiVersionGuard bounces every classic URL back to
    // /v2 while that preference says 'v2', so navigating without clearing it would
    // land the user back on the screen they just left. Announced, because it also
    // means their next login opens classic.
    clearUiVersion()
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
