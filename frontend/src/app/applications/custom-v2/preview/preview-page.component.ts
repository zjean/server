import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { ActivatedRoute } from '@angular/router'
import { PreviewComponent } from './preview.component'

// Standalone-route wrapper for the unified preview. Reads ?path=... from
// the route and forwards it to PreviewComponent in standalone mode. This
// is what the new tab from middle-click lands on — chromeless, no v2
// sidebar/header (top-level route, sibling of v2 layout).
@Component({
  selector: 'app-v2-preview-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (path(); as p) {
      <app-v2-preview [path]="p" mode="standalone" />
    } @else {
      <div class="page__error">No file path supplied.</div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        position: fixed;
        inset: 0;
        background: var(--si-bg0, #1f1f1f);
      }
      .page__error {
        color: var(--si-fg-muted, #ccc);
        padding: 24px;
        font-family: var(--si-sans, system-ui), sans-serif;
      }
    `
  ],
  imports: [PreviewComponent]
})
export class PreviewPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute)
  private readonly destroyRef = inject(DestroyRef)

  protected readonly path = signal<string>('')

  ngOnInit(): void {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const p = params.get('path') ?? ''
      this.path.set(p)
      if (p && typeof document !== 'undefined') {
        document.title = p.split('/').filter(Boolean).pop() ?? 'Preview'
      }
    })
  }
}
