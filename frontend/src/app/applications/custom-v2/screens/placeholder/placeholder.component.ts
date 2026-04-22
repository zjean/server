import { ChangeDetectionStrategy, Component, effect, inject } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { ActivatedRoute, Router } from '@angular/router'
import { ButtonComponent } from '../../components/button.component'
import { IconV2Component, IconV2Name } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { clearUiVersion } from '../../ui-version'

export interface PlaceholderRouteData {
  title: string
  icon: IconV2Name
  classicRoute?: string
  description?: string
}

@Component({
  selector: 'app-v2-placeholder',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './placeholder.component.html',
  styleUrl: './placeholder.component.scss',
  imports: [IconV2Component, ButtonComponent]
})
export class PlaceholderComponent {
  private readonly route = inject(ActivatedRoute)
  private readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)

  protected readonly data = toSignal(this.route.data)

  constructor() {
    effect(() => {
      const data = this.data() as { placeholder?: PlaceholderRouteData } | undefined
      const p = data?.placeholder
      if (p) {
        this.breadcrumbs.setBreadcrumbs([{ label: p.title, icon: p.icon }])
      } else {
        this.breadcrumbs.clear()
      }
    })
  }

  protected get placeholder(): PlaceholderRouteData | null {
    const data = this.data() as { placeholder?: PlaceholderRouteData } | undefined
    return data?.placeholder ?? null
  }

  protected openInClassic(path: string | undefined): void {
    if (!path) return
    clearUiVersion()
    this.router.navigateByUrl(path).catch(console.error)
  }
}
