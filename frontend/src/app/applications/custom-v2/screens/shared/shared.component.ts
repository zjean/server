import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { ActivatedRoute, Router } from '@angular/router'
import { Subscription } from 'rxjs'
import { TimeAgoPipe } from '../../../../common/pipes/time-ago.pipe'
import { ShareFileModel } from '../../../shares/models/share-file.model'
import { SharesService } from '../../../shares/services/shares.service'
import { FileGlyphComponent } from '../../components/file-glyph.component'
import { IconButtonComponent } from '../../components/icon-button.component'
import { IconV2Name } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { mimeToGlyph } from '../../utils/mime-to-glyph'

export type SharedVariant = 'with-me' | 'with-others' | 'via-links'

interface VariantConfig {
  title: string
  eyebrow: string
  icon: IconV2Name
  filter: (shares: ShareFileModel[]) => ShareFileModel[]
  emptyState: string
}

const CONFIGS: Record<SharedVariant, VariantConfig> = {
  'with-me': {
    title: 'With me',
    eyebrow: 'Shared',
    icon: 'person',
    filter: (shares) => shares.filter((s) => !!s.parent),
    emptyState: 'Nothing has been shared with you yet.'
  },
  'with-others': {
    title: 'With others',
    eyebrow: 'Shared',
    icon: 'arrowUp',
    filter: (shares) => shares.filter((s) => !s.parent),
    emptyState: "You haven't shared anything yet."
  },
  'via-links': {
    title: 'Via links',
    eyebrow: 'Shared',
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
  imports: [IconButtonComponent, FileGlyphComponent, TimeAgoPipe]
})
export class SharedComponent implements OnInit {
  private readonly sharesService = inject(SharesService)
  private readonly route = inject(ActivatedRoute)
  private readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
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
    this.breadcrumbs.setBreadcrumbs([
      { label: 'Shared', icon: 'share' },
      { label: CONFIGS[this.variant()].title, icon: CONFIGS[this.variant()].icon }
    ])
    this.refresh()
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
    this.router.navigate(['/spaces/shares', share.alias]).catch(console.error)
  }
}
