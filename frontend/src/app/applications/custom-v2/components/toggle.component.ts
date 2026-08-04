import { ChangeDetectionStrategy, Component, input, output } from '@angular/core'

/**
 * A switch.
 *
 * The design's rule, and the reason this is not just a restyled checkbox: **a toggle
 * is only for a setting that applies immediately with no Save.** A checkbox is for a
 * value you are about to submit. Using a toggle for a batched field promises an
 * instant effect that will not happen until the user finds the button.
 *
 * Phase 1 listed this beside the checkbox and shipped only the checkbox; the share
 * dialog is the first screen that needs it (D7 draws two — enable the link, allow
 * download).
 */
@Component({
  selector: 'app-v2-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="tg"
      [class.tg--on]="checked()"
      [class.tg--sm]="size() === 'sm'"
      role="switch"
      [attr.aria-checked]="checked()"
      [attr.aria-label]="ariaLabel()"
      [disabled]="disabled()"
      (click)="changed.emit(!checked())"
    >
      <span class="tg__knob"></span>
    </button>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
      }
      .tg {
        width: 36px;
        height: 20px;
        flex: none;
        padding: 2px;
        border: 0;
        border-radius: var(--si-r4);
        background: var(--si-bg6);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: flex-start;
        transition: background var(--si-dur-2) var(--si-ease-out);
      }
      .tg--sm {
        width: 30px;
        height: 18px;
      }
      /* On is the accent fill — this is the one control whose whole job is to say
         "this is on", and the accent means action. */
      .tg--on {
        background: var(--si-accent);
        justify-content: flex-end;
      }
      .tg:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }
      .tg:focus-visible {
        outline: 2px solid var(--si-focus-ring);
        outline-offset: 2px;
      }
      .tg__knob {
        width: 16px;
        height: 16px;
        border-radius: 50%;
        /* The knob reads against BOTH track values, so it takes the ink of the
           accent fill rather than a surface tone: --si-fg on the cobalt track
           measures 3.4:1, and the knob is the only thing that shows state. */
        background: var(--si-accent-fg);
        transition: background var(--si-dur-2) var(--si-ease-out);
      }
      .tg--sm .tg__knob {
        width: 14px;
        height: 14px;
      }
      /* Off: the knob is a tone ON the surface track, not white — white on both
         values would make off and on differ only by track colour. */
      .tg:not(.tg--on) .tg__knob {
        background: var(--si-fg-tertiary);
      }
    `
  ]
})
export class ToggleComponent {
  readonly checked = input<boolean>(false)
  readonly disabled = input<boolean>(false)
  readonly size = input<'sm' | 'md'>('md')
  readonly ariaLabel = input<string | null>(null)

  readonly changed = output<boolean>()
}
