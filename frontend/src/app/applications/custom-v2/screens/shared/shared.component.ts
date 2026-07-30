import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { ActivatedRoute, Router } from '@angular/router'
import { API_SHARES_LINKS } from '@sync-in-server/backend/src/applications/shares/constants/routes'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { Subscription } from 'rxjs'
import { TimeAgoPipe } from '../../../../common/pipes/time-ago.pipe'
import { ShareLinkModel } from '../../../links/models/share-link.model'
import { ShareFileModel } from '../../../shares/models/share-file.model'
import { SharesService } from '../../../shares/services/shares.service'
import { EmptyStateComponent } from '../../components/empty-state.component'
import { FileGlyphComponent } from '../../components/file-glyph.component'
import { IconButtonComponent } from '../../components/icon-button.component'
import { LinkDialogService } from '../../components/link-dialog.service'
import { ShareDialogService } from '../../components/share-dialog.service'
import { ToastService } from '../../components/toast.service'
import { IconV2Name } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { DockRailService } from '../../layout/dock-rail.service'
import { mimeToGlyph } from '../../utils/mime-to-glyph'

export type SharedVariant = 'with-me' | 'with-others' | 'via-links'

interface VariantConfig {
  title: string
  icon: IconV2Name
  filter: (shares: ShareFileModel[]) => ShareFileModel[]
  emptyState: string
}

const CONFIGS: Record<SharedVariant, VariantConfig> = {
  'with-me': {
    title: 'With me',
    icon: 'person',
    filter: (shares) => shares.filter((s) => !!s.parent),
    emptyState: 'Nothing has been shared with you yet.'
  },
  'with-others': {
    title: 'With others',
    icon: 'arrowUp',
    filter: (shares) => shares.filter((s) => !s.parent),
    emptyState: "You haven't shared anything yet."
  },
  'via-links': {
    title: 'Via links',
    icon: 'link',
    filter: (shares) => shares.filter((s) => (s.counts?.links ?? 0) > 0),
    emptyState: 'No link shares yet.'
  }
}

@Component({
  selector: 'app-v2-shared',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './shared.component.html',
  styleUrl: './shared.component.scss',
  imports: [IconButtonComponent, FileGlyphComponent, TimeAgoPipe, L10nTranslateDirective, L10nTranslatePipe, EmptyStateComponent]
})
export class SharedComponent implements OnInit, OnDestroy {
  private readonly sharesService = inject(SharesService)
  private readonly http = inject(HttpClient)
  private readonly route = inject(ActivatedRoute)
  private readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  private readonly dockRail = inject(DockRailService)
  private readonly linkDialog = inject(LinkDialogService)
  private readonly shareDialog = inject(ShareDialogService)
  private readonly toast = inject(ToastService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private subscription: Subscription | null = null

  protected readonly mimeToGlyph = mimeToGlyph
  protected readonly allShares = signal<ShareFileModel[]>([])
  protected readonly loading = signal(true)
  protected readonly errorMessage = signal<string | null>(null)

  protected readonly data = toSignal(this.route.data)

  protected readonly variant = computed<SharedVariant>(() => {
    const v = (this.data() as { variant?: SharedVariant } | undefined)?.variant
    return v ?? 'with-me'
  })

  protected readonly config = computed<VariantConfig>(() => CONFIGS[this.variant()])
  protected readonly shares = computed(() => this.config().filter(this.allShares()))

  ngOnInit(): void {
    // Shared rows act as direct links (click → open) — there's no
    // single-row selection state for the dock panel to read against.
    // Skip the dock-rail registration so the rail auto-hides instead of
    // surfacing tabs that resolve to "Select a file…" empty states.
    this.dockRail.clear()
    this.breadcrumbs.setBreadcrumbs([
      { label: 'Shared', icon: 'share' },
      { label: CONFIGS[this.variant()].title, icon: CONFIGS[this.variant()].icon }
    ])
    this.refresh()
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe()
    this.dockRail.clear()
  }

  protected refresh(): void {
    this.loading.set(true)
    this.errorMessage.set(null)
    this.subscription?.unsubscribe()
    this.subscription = this.sharesService.listShares().subscribe({
      next: (shares) => {
        this.allShares.set(shares.map((s) => new ShareFileModel(s)))
        this.loading.set(false)
      },
      error: () => {
        this.errorMessage.set('Failed to load shares.')
        this.loading.set(false)
      }
    })
  }

  protected openShare(share: ShareFileModel): void {
    if (this.variant() === 'via-links') {
      this.openLinkEditor(share)
      return
    }
    if (this.variant() === 'with-others') {
      this.openShareEditor(share)
      return
    }
    this.router.navigate(['/spaces/shares', share.alias]).catch(console.error)
  }

  private async openShareEditor(share: ShareFileModel): Promise<void> {
    const result = await this.shareDialog.open({ existingShareId: share.id })
    if (result?.revoked) this.refresh()
  }

  private openLinkEditor(share: ShareFileModel): void {
    // Fetch the full ShareLink (carries the single link guest) and open the link-dialog in edit mode.
    this.http.get<ShareLinkModel>(`${API_SHARES_LINKS}/${share.id}`).subscribe({
      next: async (raw) => {
        const shareLink = new ShareLinkModel(raw)
        const result = await this.linkDialog.open({ existing: shareLink })
        if (result?.revoked) this.refresh()
      },
      error: (e: HttpErrorResponse) => {
        this.toast.error(e.error?.message ?? 'Failed to open link')
      }
    })
  }

  protected recipientCount(s: ShareFileModel): number {
    return (s.counts?.users ?? 0) + (s.counts?.groups ?? 0)
  }
}
