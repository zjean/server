import { ChangeDetectionStrategy, Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { ActivatedRoute, Router } from '@angular/router'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { Subscription } from 'rxjs'
import { TimeAgoPipe } from '../../../../common/pipes/time-ago.pipe'
import { ShareFileModel } from '../../../shares/models/share-file.model'
import { SharesService } from '../../../shares/services/shares.service'
import { EmptyStateComponent } from '../../components/empty-state.component'
import { FileGlyphComponent } from '../../components/file-glyph.component'
import { IconButtonComponent } from '../../components/icon-button.component'
import { ShareDialogService } from '../../components/share-dialog.service'
import { ToastService } from '../../components/toast.service'
import { IconV2Name } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { InspectorService } from '../../layout/inspector.service'
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
  private readonly route = inject(ActivatedRoute)
  private readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  private readonly inspector = inject(InspectorService)
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

  // A link share is a share, and sharing is one dialog now — so this opens the same
  // editor the "with others" rows do. The dialog loads the share itself, which also
  // means it shows the PEOPLE on a link share, something the link dialog could not.
  private async openLinkEditor(share: ShareFileModel): Promise<void> {
    const result = await this.shareDialog.open({ existingShareId: share.id, focusLink: true })
    if (result?.revoked) this.refresh()
  }

  protected recipientCount(s: ShareFileModel): number {
    return (s.counts?.users ?? 0) + (s.counts?.groups ?? 0)
  }
}
