import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { IconV2Component, IconV2Name } from '../icons/icon-v2.component'

// Shared empty-state card for the v2 screens — one source of truth so every
// "nothing here yet" view looks identical (favorites, shares, spaces, …).
// Pattern lifted from the original favorites empty state: a dashed, centred
// card with an icon medallion, a title, and an optional lede.
//
// Strings are passed as i18n keys and translated internally, so callers don't
// each need to wire L10N_LOCALE / the translate pipe.
@Component({
  selector: 'app-v2-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconV2Component, L10nTranslatePipe],
  template: `
    <div class="empty">
      <div class="empty__icon">
        <app-v2-icon [name]="icon()" [size]="22" />
      </div>
      <div class="empty__title">{{ title() | translate: locale.language : titleParams() }}</div>
      @if (lede()) {
        <div class="empty__lede">{{ lede() | translate: locale.language : ledeParams() }}</div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 56px var(--si-space-10);
        margin: var(--si-space-8) var(--si-space-12) var(--si-space-12);
        color: var(--si-fg-faint);
        text-align: center;
        background: var(--si-bg3);
        border: 1px dashed var(--si-line-strong);
        border-radius: var(--si-r3);
      }
      .empty__icon {
        width: 48px;
        height: 48px;
        border-radius: 24px;
        background: var(--si-bg4);
        // tertiary, not ghost: ghost on bg4 measured 2.59, below the 3:1 that
        // SC 1.4.11 asks of a meaningful glyph. The icon is arguably decorative
        // (the title states the same thing), but it was also simply too faint
        // to read — tertiary lands at 3.76 (#397).
        color: var(--si-fg-tertiary);
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: var(--si-space-7);
        border: 1px solid var(--si-line);
      }
      .empty__title {
        font-family: var(--si-display);
        font-size: var(--si-text-11);
        font-weight: 500;
        color: var(--si-fg-muted);
        letter-spacing: -0.1px;
        max-width: 36ch;
      }
      .empty__lede {
        margin-top: var(--si-space-3);
        font-size: var(--si-text-9);
        color: var(--si-fg-faint);
        max-width: 32ch;
        line-height: 1.5;
      }
    `
  ]
})
export class EmptyStateComponent {
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  readonly icon = input<IconV2Name>('folder')
  readonly title = input<string>('')
  readonly lede = input<string>('')
  // Optional l10n interpolation params for parameterised keys (e.g. a query echo).
  readonly titleParams = input<Record<string, unknown> | undefined>(undefined)
  readonly ledeParams = input<Record<string, unknown> | undefined>(undefined)
}
