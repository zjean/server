import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core'
import { Router } from '@angular/router'
import { Subscription } from 'rxjs'
import { TimeAgoPipe } from '../../../../common/pipes/time-ago.pipe'
import { TrashModel } from '../../../spaces/models/trash.model'
import { SpacesService } from '../../../spaces/services/spaces.service'
import { ButtonComponent } from '../../components/button.component'
import { IconButtonComponent } from '../../components/icon-button.component'
import { IconV2Component } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'

@Component({
  selector: 'app-v2-trash',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './trash.component.html',
  styleUrl: './trash.component.scss',
  imports: [IconV2Component, IconButtonComponent, ButtonComponent, TimeAgoPipe]
})
export class TrashComponent implements OnInit {
  private readonly spacesService = inject(SpacesService)
  private readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  private subscription: Subscription | null = null

  protected readonly bins = signal<TrashModel[]>([])
  protected readonly loading = signal(true)
  protected readonly errorMessage = signal<string | null>(null)

  protected readonly totalItems = computed(() => this.bins().reduce((n, b) => n + b.nb, 0))

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
    this.router.navigate(['/spaces/trash', bin.alias]).catch(console.error)
  }
}
