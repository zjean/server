import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core'
import { RouterLink } from '@angular/router'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { IconV2Component } from '../icons/icon-v2.component'
import { V2DragService } from '../services/drag.service'
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
  imports: [IconV2Component, L10nTranslatePipe, RouterLink],
  template: `
    @if (visible()) {
      <nav class="pcb" [attr.aria-label]="'Breadcrumb' | translate: locale.language">
        @for (b of segments(); track $index; let i = $index; let last = $last) {
          @if (i > 0) {
            <app-v2-icon name="chevRight" [size]="11" class="pcb__sep" />
          }
          @if (!last && b.route) {
            <a
              class="pcb__crumb pcb__crumb--link"
              [class.pcb__crumb--drop-hover]="dropHoverIndex() === i && b.targetPath"
              [routerLink]="b.route"
              (dragover)="onDragOver($event, i, b.targetPath)"
              (dragleave)="onDragLeave(i)"
              (drop)="onDrop($event, i, b.targetPath)"
            >
              @if (b.icon) {
                <app-v2-icon [name]="b.icon" [size]="12" class="pcb__icon" />
              }
              {{ b.label | translate: locale.language }}
            </a>
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
        gap: var(--si-space-3);
        padding: var(--si-space-6) var(--si-space-12) 0;
        background: var(--si-bg2);
        font-family: var(--si-sans);
        font-size: var(--si-text-6);
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
        gap: var(--si-space-3);
        padding: 0;
        background: transparent;
        border: 0;
        font: inherit;
        color: var(--si-fg-faint);
        text-decoration: none;
        cursor: default;
        white-space: nowrap;
      }
      .pcb__crumb--link {
        color: var(--si-fg-faint);
        cursor: pointer;
        transition: color var(--si-dur-2) var(--si-ease);
      }
      .pcb__crumb--link:hover {
        color: var(--si-fg-muted);
        text-decoration: underline;
      }
      .pcb__crumb--last {
        color: var(--si-fg-muted);
        font-weight: 500;
      }
      .pcb__crumb--drop-hover {
        background: var(--si-accent-soft, rgba(58, 122, 254, 0.14));
        color: var(--si-fg-strong);
        border-radius: 6px;
        padding: var(--si-space-1) var(--si-space-3);
        margin: -2px -6px;
      }
    `
  ]
})
export class PageBreadcrumbComponent {
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  protected readonly segments = inject(V2BreadcrumbService).segments
  private readonly drag = inject(V2DragService)
  protected readonly dropHoverIndex = signal<number | null>(null)
  // Hide the strip when there are 0 segments (screen didn't register
  // anything — e.g. /v2/kit) or 1 segment with no route (a static title
  // that adds no navigation value as a breadcrumb).
  protected readonly visible = computed(() => {
    const segs = this.segments()
    if (segs.length === 0) return false
    if (segs.length === 1 && !segs[0].route) return false
    return true
  })

  protected onDragOver(event: DragEvent, index: number, targetPath: string | undefined): void {
    if (!targetPath) return
    if (!this.drag.canDropOnPath(targetPath)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    this.dropHoverIndex.set(index)
  }

  protected onDragLeave(index: number): void {
    if (this.dropHoverIndex() === index) this.dropHoverIndex.set(null)
  }

  protected onDrop(event: DragEvent, _index: number, targetPath: string | undefined): void {
    event.preventDefault()
    this.dropHoverIndex.set(null)
    if (!targetPath) return
    this.drag.dropOnPath(targetPath)
  }
}
