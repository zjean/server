import { ChangeDetectionStrategy, Component, inject } from '@angular/core'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective } from 'angular-l10n'
import { ConnectivityService } from '../services/connectivity.service'
import { IconV2Component } from '../icons/icon-v2.component'

/**
 * The session error strip — the third of the design's three error levels.
 *
 * "1. **Field** — inline, danger text. 2. **Action** — toast with Retry. 3. **Session** — a
 * persistent strip under the top bar." The first two exist; this is the third, and what
 * distinguishes it is that it does not go away on its own. A toast says an action failed; a
 * strip says the app is not currently able to do them.
 *
 * Amber rather than rose, and that is deliberate: offline is a CONDITION, not a failure.
 * Nothing has gone wrong yet — the next write will fail, which is what the strip is warning
 * about, and `--si-rose` is reserved for something that actually did.
 *
 * `role="status"` with `aria-live="polite"`: it is an ambient condition, so it is announced
 * once when it appears rather than interrupting whatever the user is doing.
 *
 * **Two of the design's three clauses for this level are not implemented, and cannot be
 * honestly faked:**
 *
 *  • *"disables write actions"* — every write in this app goes to the server and fails on
 *    its own with the toast that level 2 already specifies. Graying out every create,
 *    rename, move, upload and share button across fourteen screens would be a large surface
 *    to keep correct, and it would lie in the one case that matters most: `navigator.onLine`
 *    is true behind a captive portal or a stopped server, so the buttons would stay enabled
 *    exactly when they are most broken. The strip warns; the action reports.
 *  • *"queues local edits with a count"* — there is no offline queue anywhere in this
 *    codebase and no service worker to hold one. A count of queued edits with nothing
 *    queueing them would be a fabricated number.
 */
@Component({
  selector: 'app-v2-session-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconV2Component, L10nTranslateDirective],
  template: `
    @if (!connectivity.online()) {
      <div class="strip" role="status" aria-live="polite">
        <app-v2-icon name="info" [size]="15" class="strip__glyph" />
        <span class="strip__text" l10nTranslate>v2_offline_strip</span>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }
      .strip {
        flex: none;
        display: flex;
        align-items: center;
        gap: var(--si-space-5);
        min-height: 32px;
        padding: var(--si-space-4) var(--si-space-8);
        background: var(--si-amber-soft);
        /* The type tone, not the fill — same rule the action sheet's danger row follows. */
        color: var(--si-amber-ink);
        font-size: var(--si-text-7);
      }
      .strip__glyph {
        flex: none;
      }
      .strip__text {
        min-width: 0;
      }
    `
  ]
})
export class SessionStripComponent {
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  protected readonly connectivity = inject(ConnectivityService)
}
