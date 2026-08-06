import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { IconV2Component, IconV2Name } from '../icons/icon-v2.component'

/**
 * The bounded empty panel — D2's shape, which D6b's spec then names as its own
 * ("empty: same panel as D2").
 *
 * Two rules from the design are structural rather than decorative, and both are
 * why this is a component instead of a copied block:
 *
 *  • **Left-aligned to the content gutter, never vertically centred.** A centred
 *    card makes the page stop reading top-down, and on a tall viewport it puts the
 *    one action the user needs 400px below where they were looking.
 *  • **Bounded at 560px on `--si-bg1` with an inset hairline.** It is a panel on
 *    the content plane, not a dashed drop zone. The dashed centred card is
 *    `app-v2-empty-state`, which is a different thing for a different job (a whole
 *    screen with nothing in it yet) and stays.
 *
 * Copy is the caller's: "Zero-state, no-results and error each get their own copy;
 * never reuse 'nothing here'." So this component takes the strings and owns only
 * the shape.
 */
@Component({
  selector: 'app-v2-empty-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconV2Component, L10nTranslatePipe],
  template: `
    <div class="ep">
      <div class="ep__icon">
        <app-v2-icon [name]="icon()" [size]="22" />
      </div>
      <div class="ep__title">{{ title() | translate: locale.language : titleParams() }}</div>
      @if (body()) {
        <div class="ep__body">{{ body() | translate: locale.language : bodyParams() }}</div>
      }
      <div class="ep__actions">
        <ng-content />
      </div>
      <!-- Only rendered when something is projected: an empty footer would draw a
           divider with nothing under it. The :has() rule below is that test, in CSS,
           because Angular gives a component no way to ask whether a slot is filled. -->
      <div class="ep__footer">
        <ng-content select="[emptyPanelFooter]" />
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .ep {
        width: 100%;
        max-width: 560px;
        padding: var(--si-space-13);
        background: var(--si-bg1);
        border-radius: var(--si-r3);
        box-shadow: inset 0 0 0 1px var(--si-line-subtle);
      }
      .ep__icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 52px;
        height: 52px;
        border-radius: var(--si-r4);
        background: var(--si-bg3);
        /* tertiary, not ghost: ghost on this fill measures 2.59, below the 3:1 that
           SC 1.4.11 asks of a meaningful glyph (#397). */
        color: var(--si-fg-tertiary);
        margin-bottom: var(--si-space-9);
      }
      .ep__title {
        font-family: var(--si-sans);
        font-size: var(--si-text-12);
        font-weight: 500;
        color: var(--si-fg);
        margin-bottom: var(--si-space-4);
      }
      .ep__body {
        max-width: 48ch;
        font-size: var(--si-text-7);
        line-height: 1.65;
        color: var(--si-fg-tertiary);
        margin-bottom: var(--si-space-10);
      }
      .ep__actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--si-space-5);
      }
      .ep__footer {
        display: flex;
        gap: var(--si-space-10);
        margin-top: var(--si-space-11);
        padding-top: var(--si-space-10);
        border-top: 1px solid var(--si-line-subtle);
        font-family: var(--si-mono);
        font-size: var(--si-text-4);
        /* tertiary, not ghost. This slot is not the decorative footnote the tone
           implies: search projects "N characters minimum" into it, which is the only
           statement of why the panel is empty and what to do about it — exactly the
           "sole carrier of meaning" that _tokens.scss forbids quiet from being. At
           ghost it measured 2.52 on the panel's bg1; tertiary is 5.02 there. Found by
           the surface-outward contrast audit described with the tier in _tokens.scss,
           not by reading this file. */
        color: var(--si-fg-tertiary);
      }
      /* Collapses when nothing is projected, so an actionless panel does not draw a
         divider with empty space under it.
         AFTER the rule it overrides, deliberately: :not() takes the specificity of
         its argument, and :has(*) contributes none — so both selectors weigh
         0,1,0 and source order is the only tiebreaker. Written first, this loses. */
      .ep__footer:not(:has(*)) {
        display: none;
      }
    `
  ]
})
export class EmptyPanelComponent {
  readonly icon = input<IconV2Name>('info')
  /** i18n keys — translated here so callers don't each wire the pipe. */
  readonly title = input.required<string>()
  readonly body = input<string | null>(null)
  readonly titleParams = input<Record<string, unknown> | undefined>(undefined)
  readonly bodyParams = input<Record<string, unknown> | undefined>(undefined)

  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
}
