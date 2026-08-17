import { ChangeDetectionStrategy, Component, input, output } from '@angular/core'
import { IconV2Component, IconV2Name } from '../icons/icon-v2.component'
import { FileThumbComponent } from './file-thumb.component'
import { TimestampComponent } from './timestamp.component'

// The v2 file row — one file, its location, when it changed, and whatever the
// screen wants to hang off it.
//
// It replaces four hand-maintained rows that were the same row: `.recent-row`,
// `.favorite-row`, `.share-row` and `.bin-row`. (`.file-row` in the file browser
// is deliberately NOT one of them — it carries density, selection and drag-and-drop
// semantics and belongs to the consolidated browser base from #346.)
//
// ─── Why this is a <div> wrapping a <button>, and not a <button> ───────────
// The rows it replaces were each a single `<button class="…-row">` with everything
// inside. That works while the row is only a navigation target, which is why
// recents and favorites got away with it — favorites' trailing star is an
// `<app-v2-icon>`, a state glyph with no behaviour.
//
// It stops working the moment a row carries an action. Three screens — trash,
// shared and trash-bin — put an `<app-v2-icon-btn>` inside that outer button, and
// `app-v2-icon-btn` renders a real `<button>`. A button may not contain
// interactive content: the markup is invalid, the inner control's activation is
// ambiguous, and assistive technology is handed a control containing a control.
// It renders fine, so nothing caught it.
//
// So the row is a plain element, the primary target is ONE button holding the
// tile and the text, and that button's `::after` is stretched over the whole row
// to keep the entire strip clickable. Actions sit outside it as siblings. The
// result is one tab stop for "open this file" plus one per action, which is what
// a row with actions should expose, and it is valid HTML.
//
// The focus ring is then moved from the inner button to the row, because a ring
// drawn around the stretched button would trace the text box rather than the row
// the user is on.
//
// ─── Why the class is `v2-row` and not `row` ───────────────────────────────
// Because `row` was, and it broke the layout on mobile in a way that measured as
// a 24px horizontal overflow inside the list. Bootstrap is loaded globally for the
// classic UI, and `.row` is one of its grid classes:
//
//   .row      { display: flex; flex-wrap: wrap;
//               margin-right: calc(-.5 * var(--bs-gutter-x));   /* -12px */
//               margin-left:  calc(-.5 * var(--bs-gutter-x)); }
//   .row > *  { width: 100%; padding-inline: calc(var(--bs-gutter-x) * .5); }
//
// View encapsulation does NOT protect against this. Encapsulation scopes the
// selectors this component writes; it does nothing about a global selector that
// happens to match an element in this component's template. So the negative
// gutter margins widened every row by 24px past its container, and `.row > *`
// put 12px of padding on all four children — including the two empty projection
// wrappers, which is why an unused badge slot rendered 24px wide.
//
// It is the same collision `custom-v2`'s notes record for `code { color: … }`,
// reached through a class name instead of an element selector, and it is invisible
// to `styles/tokens.spec.ts` for the same reason: nothing here names a colour and
// nothing here is wrong on its own. Namespace any class that could plausibly be a
// utility name — `row`, `card`, `badge`, `col`, `active`, `show`, `container`.
@Component({
  selector: 'app-v2-file-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconV2Component, FileThumbComponent, TimestampComponent],
  template: `
    <div class="v2-row" [class.v2-row--disabled]="disabled()">
      <button
        class="v2-row__main"
        type="button"
        [disabled]="disabled()"
        [attr.aria-label]="ariaLabel() || null"
        (click)="open.emit($event)"
        (auxclick)="onAuxClick($event)"
        (contextmenu)="menu.emit($event)"
      >
        <span class="v2-row__tile" [style.width.px]="tileSize()" [style.height.px]="tileSize()">
          <app-v2-file-thumb
            [file]="{ name: name(), mime: mime(), isDir: isDir() }"
            [serverPath]="serverPath()"
            [glyphSize]="tileSize()"
            [rounded]="8"
            [imageRes]="128"
          />
        </span>
        <span class="v2-row__text">
          <span class="v2-row__name v2-body-strong">{{ name() }}</span>
          @if (path()) {
            <span class="v2-row__path">
              <!-- Meaningful, not decorative: this glyph is what tells the user
                   whether the file is their own, in a Space, or shared with them,
                   so it carries an accessible name rather than aria-hidden. The
                   name lands inside the primary button, so it joins the row's own
                   accessible name — "card-mobile.jpg, Space, marketing/Social". -->
              <span class="v2-row__path-icon" role="img" [attr.aria-label]="pathIconLabel() || null">
                <app-v2-icon [name]="pathIcon()" [size]="10" />
              </span>
              <span class="v2-mono-path v2-row__path-text">{{ path() }}</span>
            </span>
          }
        </span>
      </button>

      <span class="v2-row__badges"><ng-content select="[rowBadges]" /></span>

      @if (mtime() !== null && mtime() !== undefined) {
        <app-v2-timestamp class="v2-row__time" [ms]="mtime()" [now]="now()" />
      }

      <span class="v2-row__actions"><ng-content select="[rowActions]" /></span>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .v2-row {
        /* ─── The tertiary re-point ───────────────────────────────────────
           Same fix, same reason as styles/_card.scss: this row hovers to bg3,
           where --si-fg-tertiary measures 4.37 and is not legal as text. The
           row's own timestamp uses the .v2-mono-data role, which names tertiary
           — so without this the date would be legal at rest and illegal under
           the pointer, the "correct in one state, wrong in another" class that
           no edit to the declaration itself can fix. Declared unconditionally
           rather than on :hover so both states resolve to one value. */
        --si-fg-tertiary: var(--si-fg-muted);

        /* The positioned ancestor the stretched target resolves against. */
        position: relative;
        display: grid;
        /* minmax(0, 1fr) rather than 1fr: a bare 1fr takes its floor from the
           content's min-content width, so one long unbroken filename widens the
           track and pushes the trailing columns off the row instead of
           ellipsing. */
        grid-template-columns: minmax(0, 1fr) auto auto auto;
        align-items: center;
        gap: var(--si-space-5);
        padding: var(--si-space-5) var(--si-space-6);
        border-radius: var(--si-r2);
        transition: background var(--si-dur-2) var(--si-ease-out);
      }

      .v2-row:hover {
        background: var(--si-bg3);
      }

      /* Pressed is shading, never motion — the rows this replaces used a 1px
         translateY, which _tokens.scss bans outright ("NO CONTROL EVER MOVES ON
         PRESS"). */
      .v2-row:active:not(.v2-row--disabled) {
        box-shadow: var(--si-shadow-press);
      }

      /* The ring belongs to the row, not to the stretched button inside it.
         :has() is already used elsewhere in v2 (layout, segmented, empty-panel),
         so this needs no new browser floor. */
      .v2-row:has(> .v2-row__main:focus-visible) {
        outline: 2px solid var(--si-focus-ring);
        outline-offset: -2px;
      }

      /* Inset, unlike the global +2px offset: rows sit flush against their
         neighbours, so an outward ring would overlap the row above. Drawn inside,
         it reads as a highlighted row rather than a box between two rows. */
      .v2-row__main:focus-visible {
        outline: none;
      }

      .v2-row__main {
        display: flex;
        align-items: center;
        gap: var(--si-space-6);
        min-width: 0;
        padding: 0;
        border: none;
        background: none;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }

      /* What makes the whole strip clickable while only the text is the button.
         Sits beneath the trailing columns in paint order, which is why those
         disable pointer events rather than raising a z-index. */
      .v2-row__main::after {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: inherit;
      }

      .v2-row--disabled .v2-row__main {
        cursor: default;
      }

      .v2-row--disabled {
        opacity: 0.55;
      }

      .v2-row--disabled:hover {
        background: none;
      }

      .v2-row__tile {
        position: relative;
        flex-shrink: 0;
        overflow: hidden;
        border-radius: 8px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .v2-row__text {
        display: flex;
        flex-direction: column;
        gap: var(--si-space-2);
        min-width: 0;
      }

      /* Truncation lives here rather than on the role class: .v2-body-strong is
         a type role and has no opinion about layout. */
      .v2-row__name,
      .v2-row__path-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .v2-row__path {
        display: flex;
        align-items: center;
        gap: var(--si-space-3);
        min-width: 0;
      }

      .v2-row__path-icon {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        /* tertiary is legal here for the same reason the exemptions in
           _tokens.scss name: SC 1.4.11 asks 3:1 of a meaningful non-text element,
           not the 4.5:1 it asks of text, and tertiary clears that down to bg6.
           The row's re-point lifts it to muted anyway. */
        color: var(--si-fg-tertiary);
      }

      /* Non-interactive trailing content: clicks fall through to the stretched
         target so the row still opens when the pointer happens to be over a badge
         or the date. */
      .v2-row__badges,
      .v2-row__time {
        pointer-events: none;
      }

      .v2-row__badges {
        display: inline-flex;
        align-items: center;
        gap: var(--si-space-4);
      }

      /* Above the stretched target and clickable, unlike its two neighbours. */
      .v2-row__actions {
        position: relative;
        z-index: 1;
        pointer-events: auto;
        display: inline-flex;
        align-items: center;
        gap: var(--si-space-3);
      }

      /* Actions are revealed on hover and on keyboard focus. focus-within is not
         optional here: without it a keyboard user tabbing into an action cannot
         see the control they are on. */
      .v2-row__actions:not(:empty) {
        opacity: 0;
        transition: opacity var(--si-dur-2) var(--si-ease-out);
      }

      .v2-row:hover .v2-row__actions,
      .v2-row:focus-within .v2-row__actions {
        opacity: 1;
      }

      /* Coarse pointers get no hover, so hidden-until-hover would make the
         actions unreachable on a touch device. */
      @media (hover: none) {
        .v2-row__actions:not(:empty) {
          opacity: 1;
        }
      }

      @media (max-width: 560px) {
        /* The date drops below the name rather than off the row: at this width the
           four-column grid cannot hold a filename and a date on one line without
           ellipsing the filename to nothing. */
        .v2-row {
          grid-template-columns: minmax(0, 1fr) auto auto;
          gap: var(--si-space-4);
          padding: var(--si-space-5) var(--si-space-4);
        }

        .v2-row__time {
          grid-column: 1;
          grid-row: 2;
          /* Aligns under the text column, clearing the tile. */
          padding-left: calc(var(--si-space-6) + 36px);
        }
      }
    `
  ]
})
export class FileRowComponent {
  readonly name = input.required<string>()
  readonly mime = input<string>('')
  readonly isDir = input<boolean>(false)

  // The addressable, repository-qualified path — `files/<alias>/<dirs>/<name>` or
  // `shares/<alias>/…`. Required by FileThumb for the same reason issue #428
  // records: the repository prefix is a fact about the SCREEN, not about the row,
  // and a browse payload splits the rest across `path` (parent dir) and `name`.
  // Passing the raw parent path here makes every thumbnail request the directory.
  readonly serverPath = input<string>('')

  // The human-readable location shown under the name — a display string, not an
  // address. Empty renders no second line at all.
  readonly path = input<string>('')

  // The glyph beside the path. Defaults to `folder`, which is what every row used
  // to hard-code; callers that know a file's origin should pass the matching mark
  // (see FILE_ORIGIN_ICONS) so the row says WHERE the file came from without
  // spending a word on it.
  readonly pathIcon = input<IconV2Name>('folder')
  // Accessible name for that glyph. Required in practice whenever `pathIcon` is
  // not the default: an origin the sighted user reads from a mark is an origin the
  // AT user gets only from this.
  readonly pathIconLabel = input<string>('')

  readonly mtime = input<number | string | Date | null | undefined>(null)
  readonly now = input<number | null>(null)

  readonly tileSize = input<number>(36)
  readonly disabled = input<boolean>(false)

  // Overrides the accessible name, which otherwise comes from the button's text
  // (the filename, then the path). Worth setting where the filename alone is
  // ambiguous — a listing of four files all called README.md, say.
  readonly ariaLabel = input<string>('')

  readonly open = output<MouseEvent>()
  readonly aux = output<MouseEvent>()
  readonly menu = output<MouseEvent>()

  // Middle click only. `auxclick` also fires for the right button in some
  // browsers, and forwarding that would open a new tab AND a context menu.
  protected onAuxClick(event: MouseEvent): void {
    if (event.button !== 1) return
    event.preventDefault()
    this.aux.emit(event)
  }
}
