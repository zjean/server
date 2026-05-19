import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core'
import { Router } from '@angular/router'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { IconV2Component } from '../icons/icon-v2.component'
import { V2BreadcrumbService } from './breadcrumb.service'

// In-page breadcrumb chip rendered above each screen's toolbar.
//
// Reads from V2BreadcrumbService — the same signal each screen feeds via
// breadcrumbs.setBreadcrumbs() in ngOnInit — so screens don't need to
// know about this component. Mounted once in layout-v2 (inside <main>
// above the router-outlet) and just listens.
//
// When the segments list is empty (or has a single root entry) it
// renders nothing so screens that don't push breadcrumbs don't get a
// blank strip taking vertical room.
@Component({
  selector: 'app-v2-page-breadcrumb',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconV2Component, L10nTranslatePipe],
  template: `
    @if (visible()) {
      <nav class="pcb" [attr.aria-label]="'Breadcrumb' | translate: locale.language">
        @for (b of segments(); track $index; let i = $index; let last = $last) {
          @if (i > 0) {
            <app-v2-icon name="chevRight" [size]="11" class="pcb__sep" />
          }
          @if (!last && b.route) {
            <button type="button" class="pcb__crumb pcb__crumb--link" (click)="navigate(b.route)">
              @if (b.icon) {
                <app-v2-icon [name]="b.icon" [size]="12" class="pcb__icon" />
              }
              {{ b.label | translate: locale.language }}
            </button>
          } @else {
            <span class="pcb__crumb pcb__crumb--last">
              @if (b.icon) {
                <app-v2-icon [name]="b.icon" [size]="12" class="pcb__icon" />
              }
              {{ b.label | translate: locale.language }}
            </span>
          }
        }
      </nav>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .pcb {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 12px 28px 0;
        background: var(--si-bg2);
        font-family: var(--si-sans);
        font-size: 12px;
        line-height: 1.4;
        color: var(--si-fg-faint);
      }
      .pcb__sep {
        opacity: 0.55;
        flex-shrink: 0;
      }
      .pcb__icon {
        opacity: 0.85;
        flex-shrink: 0;
      }
      .pcb__crumb {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 0;
        background: transparent;
        border: 0;
        font: inherit;
        color: var(--si-fg-faint);
        cursor: default;
        white-space: nowrap;
      }
      .pcb__crumb--link {
        color: var(--si-fg-faint);
        cursor: pointer;
        transition: color 120ms ease;
      }
      .pcb__crumb--link:hover {
        color: var(--si-fg-muted);
      }
      .pcb__crumb--last {
        color: var(--si-fg-muted);
        font-weight: 500;
      }
    `
  ]
})
export class PageBreadcrumbComponent {
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private readonly router = inject(Router)
  protected readonly segments = inject(V2BreadcrumbService).segments
  // Hide the strip when there are 0 segments (screen didn't register
  // anything — e.g. /v2/kit) or 1 segment with no route (a static title
  // that adds no navigation value as a breadcrumb).
  protected readonly visible = computed(() => {
    const segs = this.segments()
    if (segs.length === 0) return false
    if (segs.length === 1 && !segs[0].route) return false
    return true
  })

  protected navigate(route: string | string[] | undefined): void {
    if (!route) return
    this.router.navigate(Array.isArray(route) ? route : [route]).catch(console.error)
  }
}
