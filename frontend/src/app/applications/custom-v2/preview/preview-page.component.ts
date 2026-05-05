import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { ActivatedRoute, Router } from '@angular/router'
import { V2_PATH, V2_ROUTES } from '../v2.constants'

// Backward-compat redirect: the old /v2/preview?path=... standalone route
// now points to /v2/file?path=... so bookmarks and external links keep working.
@Component({
  selector: 'app-v2-preview-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ''
})
export class PreviewPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute)
  private readonly router = inject(Router)
  private readonly destroyRef = inject(DestroyRef)

  ngOnInit(): void {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const path = params.get('path') ?? ''
      this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: path ? { path } : {}, replaceUrl: true }).catch(console.error)
    })
  }
}
