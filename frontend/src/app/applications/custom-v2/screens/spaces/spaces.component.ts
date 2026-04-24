import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core'
import { Router } from '@angular/router'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { Subscription } from 'rxjs'
import { ToBytesPipe } from '../../../../common/pipes/to-bytes.pipe'
import { TimeAgoPipe } from '../../../../common/pipes/time-ago.pipe'
import { SpacesService } from '../../../spaces/services/spaces.service'
import { SpaceModel } from '../../../spaces/models/space.model'
import { ButtonComponent } from '../../components/button.component'
import { IconButtonComponent } from '../../components/icon-button.component'
import { IconV2Component } from '../../icons/icon-v2.component'
import { PillComponent } from '../../components/pill.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'
import { CreateSpaceModalComponent } from './create-space-modal.component'

@Component({
  selector: 'app-v2-spaces',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './spaces.component.html',
  styleUrl: './spaces.component.scss',
  imports: [
    IconV2Component,
    ButtonComponent,
    IconButtonComponent,
    PillComponent,
    ToBytesPipe,
    TimeAgoPipe,
    CreateSpaceModalComponent,
    L10nTranslateDirective,
    L10nTranslatePipe
  ]
})
export class SpacesComponent implements OnInit {
  private readonly spacesService = inject(SpacesService)
  private readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private subscription: Subscription | null = null

  protected readonly spaces = signal<SpaceModel[]>([])
  protected readonly loading = signal(true)
  protected readonly errorMessage = signal<string | null>(null)
  protected readonly createOpen = signal(false)

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
    this.router.navigate(['/', V2_PATH, V2_ROUTES.SPACES, space.alias]).catch(console.error)
  }

  protected createSpace(): void {
    this.createOpen.set(true)
  }

  protected onCreateClosed(): void {
    this.createOpen.set(false)
  }

  protected onSpaceCreated(): void {
    this.createOpen.set(false)
    this.refresh()
  }

  protected memberCount(space: SpaceModel): number {
    return (space.counts?.users ?? 0) + (space.counts?.groups ?? 0)
  }
}
