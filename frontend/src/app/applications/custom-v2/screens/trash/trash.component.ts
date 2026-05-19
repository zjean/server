import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core'
import { Router } from '@angular/router'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { Subscription } from 'rxjs'
import { TimeAgoPipe } from '../../../../common/pipes/time-ago.pipe'
import { TrashModel } from '../../../spaces/models/trash.model'
import { SpacesService } from '../../../spaces/services/spaces.service'
import { IconButtonComponent } from '../../components/icon-button.component'
import { ToastService } from '../../components/toast.service'
import { IconV2Component } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'

@Component({
  selector: 'app-v2-trash',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './trash.component.html',
  styleUrl: './trash.component.scss',
  imports: [IconV2Component, IconButtonComponent, TimeAgoPipe, L10nTranslateDirective, L10nTranslatePipe]
})
export class TrashComponent implements OnInit {
  private readonly spacesService = inject(SpacesService)
  private readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  private readonly toast = inject(ToastService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private subscription: Subscription | null = null

  protected readonly bins = signal<TrashModel[]>([])
  protected readonly loading = signal(true)
  protected readonly errorMessage = signal<string | null>(null)

  protected readonly totalItems = computed(() => this.bins().reduce((n, b) => n + b.nb, 0))

  protected readonly subtitleKey = computed(() => {
    const itemsOne = this.totalItems() === 1
    const binsOne = this.bins().length === 1
    if (itemsOne && binsOne) return 'one_item_across_one_bin'
    if (itemsOne) return 'one_item_across_nb_bins'
    if (binsOne) return 'nb_items_across_one_bin'
    return 'nb_items_across_nb_bins'
  })

  ngOnInit(): void {
    this.breadcrumbs.setBreadcrumbs([{ label: 'Trash', icon: 'trash' }])
    this.refresh()
  }

  protected refresh(): void {
    this.loading.set(true)
    this.errorMessage.set(null)
    this.subscription?.unsubscribe()
    this.subscription = this.spacesService.listTrashBins().subscribe({
      next: (bins) => {
        this.bins.set(bins.map((b) => new TrashModel(b)))
        this.loading.set(false)
      },
      error: () => {
        this.errorMessage.set('Failed to load trash.')
        this.loading.set(false)
      }
    })
  }

  protected openBin(bin: TrashModel): void {
    if (!bin.enabled) {
      this.toast.info('v2_space_disabled_in_trash', { name: bin.name })
      return
    }
    this.router.navigate(['/', V2_PATH, V2_ROUTES.TRASH, bin.alias]).catch(console.error)
  }
}
