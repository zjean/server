import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core'
import { Router } from '@angular/router'
import { Subscription } from 'rxjs'
import { ToBytesPipe } from '../../../../common/pipes/to-bytes.pipe'
import { TimeAgoPipe } from '../../../../common/pipes/time-ago.pipe'
import { SpacesService } from '../../../spaces/services/spaces.service'
import { SpaceModel } from '../../../spaces/models/space.model'
import { IconButtonComponent } from '../../components/icon-button.component'
import { IconV2Component } from '../../icons/icon-v2.component'
import { PillComponent } from '../../components/pill.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'

@Component({
  selector: 'app-v2-spaces',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './spaces.component.html',
  styleUrl: './spaces.component.scss',
  imports: [IconV2Component, IconButtonComponent, PillComponent, ToBytesPipe, TimeAgoPipe]
})
export class SpacesComponent implements OnInit {
  private readonly spacesService = inject(SpacesService)
  private readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  private subscription: Subscription | null = null

  protected readonly spaces = signal<SpaceModel[]>([])
  protected readonly loading = signal(true)
  protected readonly errorMessage = signal<string | null>(null)

  protected readonly sortedSpaces = computed(() => [...this.spaces()].sort((a, b) => (b.modifiedAt?.valueOf() ?? 0) - (a.modifiedAt?.valueOf() ?? 0)))

  ngOnInit(): void {
    this.breadcrumbs.setBreadcrumbs([{ label: 'Spaces', icon: 'box' }])
    this.refresh()
  }

  protected refresh(): void {
    this.loading.set(true)
    this.errorMessage.set(null)
    this.subscription?.unsubscribe()
    this.subscription = this.spacesService.listSpaces().subscribe({
      next: (spaces) => {
        this.spaces.set(spaces)
        this.loading.set(false)
      },
      error: () => {
        this.errorMessage.set('Failed to load spaces.')
        this.loading.set(false)
      }
    })
  }

  protected openSpace(space: SpaceModel): void {
    this.router.navigate(['/spaces/files', space.alias]).catch(console.error)
  }

  protected createSpace(): void {
    this.router.navigate(['/spaces'], { queryParams: { new: 1 } }).catch(console.error)
  }

  protected memberCount(space: SpaceModel): number {
    return (space.counts?.users ?? 0) + (space.counts?.groups ?? 0)
  }
}
