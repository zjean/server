import { ChangeDetectionStrategy, Component, HostListener, computed, effect, inject } from '@angular/core'
import { PreviewComponent } from './preview.component'
import { PreviewOverlayService } from './preview-overlay.service'

// Mounts the PreviewComponent as a fullscreen overlay over the v2 layout.
// Reads "is the overlay open + which file" from PreviewOverlayService and
// renders nothing when closed (no DOM cost).
//
// The backdrop click closes the overlay; clicks inside the preview itself
// don't close (stopPropagation on the inner section).
@Component({
  selector: 'app-v2-preview-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (overlay.current(); as cur) {
      <div class="overlay" (click)="onBackdropClick($event)">
        <div class="overlay__inner" (click)="$event.stopPropagation()">
          <app-v2-preview [path]="cur.path" [fileHint]="cur.file" mode="overlay" />
        </div>
      </div>
    }
  `,
  styles: [
    `
      .overlay {
        position: fixed;
        inset: 0;
        z-index: 90;
        background: rgba(0, 0, 0, 0.55);
        backdrop-filter: blur(2px);
        display: flex;
        align-items: stretch;
        justify-content: stretch;
      }
      .overlay__inner {
        flex: 1 1 auto;
        display: flex;
        min-height: 0;
      }
    `
  ],
  imports: [PreviewComponent]
})
export class PreviewOverlayComponent {
  protected readonly overlay = inject(PreviewOverlayService)
  protected readonly bodyShouldLock = computed(() => this.overlay.isOpen())

  constructor() {
    // Lock body scroll while overlay is open so the underlying screen
    // doesn't scroll behind the backdrop.
    effect(() => {
      if (typeof document === 'undefined') return
      document.body.style.overflow = this.bodyShouldLock() ? 'hidden' : ''
    })
  }

  protected onBackdropClick(_ev: MouseEvent): void {
    this.overlay.close()
  }

  // Browser back is the canonical close (history.back), but listening
  // here covers the edge case of the user hitting Esc while the focus is
  // outside the preview component (the preview's window:keydown handler
  // would also catch it, but only if focus is on a relevant element).
  @HostListener('window:keydown.escape', ['$event'])
  onEsc(ev: KeyboardEvent): void {
    if (!this.overlay.isOpen()) return
    ev.preventDefault()
    this.overlay.close()
  }
}
