import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core'
import { IconV2Component, IconV2Name } from '../icons/icon-v2.component'

// Mobile-only floating action button. Anchors above the bottom tab bar
// (which is 60px tall + safe-area). Hidden on desktop via :host
// display:none — the desktop toolbar already exposes the same actions
// inline so a FAB would be redundant.
//
// Single-action only: pass [icon] and [aria-label], bind (action)
// to your primary CTA. Multi-action variants (action sheet) are out
// of scope; if you need that, fall back to the toolbar buttons (the
// mobile toolbar wraps so they all stay reachable).
@Component({
  selector: 'app-v2-fab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconV2Component],
  template: `
    <button type="button" class="fab" [attr.aria-label]="ariaLabel" (click)="action.emit()">
      <app-v2-icon [name]="icon" [size]="22" />
    </button>
  `,
  styles: [
    `
      :host {
        display: none;
      }
      :host-context(.layout-v2--mobile) {
        display: block;
      }
      .fab {
        position: fixed;
        right: 20px;
        bottom: calc(80px + env(safe-area-inset-bottom, 0px));
        width: 56px;
        height: 56px;
        border-radius: 50%;
        background: var(--si-accent);
        color: var(--si-accent-fg);
        border: 0;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: var(--si-shadow3);
        z-index: 20;
        transition:
          background 120ms ease,
          transform 120ms ease;
      }
      .fab:hover {
        background: var(--si-accent-hover);
      }
      .fab:active {
        transform: scale(0.96);
      }
    `
  ]
})
export class FabComponent {
  @Input({ required: true }) icon!: IconV2Name
  @Input() ariaLabel = ''
  @Output() readonly action = new EventEmitter<void>()
}
