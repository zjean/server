import { ChangeDetectionStrategy, Component, HostListener, computed, inject } from '@angular/core'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { LayoutV2Service } from '../layout/layout-v2.service'
import { shortcutGroups } from '../utils/shortcut-label'
import { ButtonComponent } from './button.component'

/**
 * The `?` shortcut sheet (the design's `4b`, the last item in its ambient-hints list).
 *
 * The design's argument for printing shortcuts where the action lives is that a user should
 * not have to go looking; this sheet is for the ones with nowhere to be printed — `F2` and
 * `F` act on a selected row and there is no chrome beside a row to print them in.
 *
 * It carries the `_dialog.scss` classes, so on a touch layout it is already a bottom sheet
 * (`M5`) and needs nothing of its own for that. Which is slightly funny for a list of
 * keyboard shortcuts — but a Bluetooth keyboard on a tablet is exactly the case where
 * someone reaches for `?`, and the alternative is a dialog that renders as a centred box on
 * the one layout where every other dialog does not.
 */
@Component({
  selector: 'app-v2-shortcuts-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, L10nTranslateDirective, L10nTranslatePipe],
  template: `
    @if (layoutV2.shortcutsOpen()) {
      <div class="v2-dialog-backdrop" (click)="close()" aria-hidden="true"></div>
      <div class="v2-dialog sc" role="dialog" aria-modal="true" [attr.aria-label]="'Keyboard shortcuts' | translate: locale.language">
        <div class="v2-dialog__head">
          <div>
            <div class="v2-dialog__title" l10nTranslate>Keyboard shortcuts</div>
            <div class="v2-dialog__subject" l10nTranslate>v2_shortcuts_subject</div>
          </div>
        </div>
        <div class="v2-dialog__body">
          @for (group of groups(); track group.title) {
            <div class="v2-label sc__group" l10nTranslate>{{ group.title }}</div>
            @for (row of group.rows; track row.keys) {
              <div class="sc__row">
                <span class="sc__label">{{ row.label | translate: locale.language }}</span>
                <kbd class="sc__keys">{{ row.keys }}</kbd>
              </div>
            }
          }
        </div>
        <div class="v2-dialog__footer">
          <span class="v2-dialog__spacer"></span>
          <app-v2-btn kind="primary" size="sm" (click)="close()">
            {{ 'Close' | translate: locale.language }}<span class="v2-dialog__kbd">esc</span>
          </app-v2-btn>
        </div>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }
      .sc__group {
        margin: var(--si-space-7) 0 var(--si-space-3);
      }
      .sc__group:first-child {
        margin-top: 0;
      }
      .sc__row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--si-space-8);
        min-height: 32px;
        border-bottom: 1px solid var(--si-line-subtle);
      }
      .sc__row:last-child {
        border-bottom: 0;
      }
      .sc__label {
        font-size: var(--si-text-7);
        color: var(--si-fg-muted);
      }
      /* A keystroke is machine vocabulary — mono, on the surface step a chip sits on. */
      .sc__keys {
        font-family: var(--si-mono);
        font-size: var(--si-text-4);
        color: var(--si-fg);
        background: var(--si-bg3);
        border-radius: var(--si-r0);
        padding: 2px var(--si-space-4);
        white-space: nowrap;
      }
    `
  ]
})
export class ShortcutsDialogComponent {
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  protected readonly layoutV2 = inject(LayoutV2Service)

  // Computed rather than a field: the modifier is read from the platform, and a signal read
  // keeps this in one place if the sheet is ever opened before `navigator` exists (SSR).
  protected readonly groups = computed(() => shortcutGroups())

  @HostListener('window:keydown.escape')
  protected onEscape(): void {
    if (this.layoutV2.shortcutsOpen()) this.close()
  }

  protected close(): void {
    this.layoutV2.shortcutsOpen.set(false)
  }
}
