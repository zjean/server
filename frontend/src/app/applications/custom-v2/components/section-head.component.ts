import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'

// The list section header — a label, an optional count, an optional trailing rule.
//
// Five screens (recents, favorites, trash, file-browser, file-detail) each
// carried their own `__section-label` + `__count-pill` pair, all four
// declarations deep and all five slightly different. This is the one spelling.
//
// Strings arrive as i18n keys and are translated internally, matching
// EmptyStateComponent, so callers do not each wire L10N_LOCALE and the pipe.
//
// ─── Why the count is mono and the label is not ────────────────────────────
// Both were sans before, which made a human-authored section title ("Pick up
// where you left off") and a machine-counted number render in the same voice.
// v2's governing type rule separates them: Plex Sans for anything a PERSON
// wrote, Plex Mono for anything a SYSTEM produced. A count is produced.
//
// The same rule is what gives `variant` its two values, and it is doing real
// hierarchy work rather than decoration. A recents page stacks two KINDS of
// header: one names a human idea ("Recent comments") and the others name computed
// date ranges ("Today", "This month"). Rendered identically — which is what five
// tracked-uppercase eyebrows down one page looked like — they read as one
// repeated ornament. Rendered in their own families they read as two levels, and
// the distinction costs no new colour, size or weight.
@Component({
  selector: 'app-v2-section-head',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [L10nTranslatePipe],
  template: `
    <div class="head" [class.head--sticky]="sticky()">
      <span class="head__label" [class.head__label--mono]="variant() === 'mono'">{{ label() | translate: locale.language }}</span>
      @if (count() !== null) {
        <span class="head__count">{{ count() }}</span>
      }
      @if (rule()) {
        <span class="head__rule"></span>
      }
      <ng-content />
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .head {
        display: flex;
        align-items: center;
        gap: var(--si-space-5);
      }

      /* Sticky is opt-in: it is right for a date-bucket head inside a long
         scrolling list and wrong for a one-off section title, which would then
         hover over content it has already been scrolled past.

         The gradient, rather than a flat fill, is what the bucket heads used
         before and it is worth keeping: rows pass UNDER the label and fade out
         instead of being clipped by a hard edge. It names the content plane by
         default and is re-pointable, because a sticky head over a panel at a
         different step would otherwise smear the wrong colour over it. */
      .head--sticky {
        position: sticky;
        top: 0;
        z-index: var(--si-z-base);
        background: linear-gradient(var(--v2-section-head-bg, var(--si-bg2)) 70%, transparent);
      }

      /* The label takes .v2-label's shape — uppercase, tracked, 11px/500 — but
         declares it locally rather than wearing the class, because the mono
         variant has to override the family and the tracking together and doing
         that on top of a role class means fighting it. */
      .head__label {
        font-family: var(--si-sans);
        font-size: var(--si-text-4);
        font-weight: 500;
        line-height: 1;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        /* muted, not tertiary: this label sits on the content plane today, where
           tertiary is legal (4.84) — but a section head is a thing you read to
           orient yourself, and the roles reserve tertiary for metadata you skim
           past. It also keeps the header correct if a caller mounts it on a card
           or a sheet, where tertiary fails outright. */
        color: var(--si-fg-muted);
        white-space: nowrap;
      }

      /* Mono carries less tracking on purpose: monospace is already open, so the
         0.1em that makes a sans label read as a label makes a mono one read as
         spaced-out capitals. */
      .head__label--mono {
        font-family: var(--si-mono);
        letter-spacing: 0.04em;
      }

      .head__count {
        display: inline-flex;
        align-items: center;
        height: 18px;
        padding: 0 var(--si-space-4);
        border-radius: var(--si-r4);
        background: var(--si-bg3);
        color: var(--si-fg-muted);
        font-family: var(--si-mono);
        font-size: var(--si-text-3);
        line-height: 1;
        /* Globally set on .v2-root already, restated because this element is a
           column of numbers whose alignment is the reason the setting exists. */
        font-variant-numeric: tabular-nums;
      }

      /* Hairline to the end of the row. --si-line-subtle is the default and
         commonest rule value in the system; --si-line is for card outlines and
         menu separators, which this is not. */
      .head__rule {
        flex: 1 1 auto;
        height: 1px;
        background: var(--si-line-subtle);
      }
    `
  ]
})
export class SectionHeadComponent {
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  // An i18n key, translated here.
  readonly label = input<string>('')
  // null renders no pill at all — distinct from 0, which is a real count and
  // renders as "0". A section with genuinely nothing in it should not be on the
  // page, but a filtered one legitimately reads zero.
  readonly count = input<number | null>(null)
  readonly variant = input<'sans' | 'mono'>('sans')
  readonly rule = input<boolean>(false)
  readonly sticky = input<boolean>(false)
}
