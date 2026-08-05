import { ChangeDetectionStrategy, Component, computed, ElementRef, input, output, viewChild } from '@angular/core'
import { IconV2Component, IconV2Name } from '../icons/icon-v2.component'

export type InputSize = 'sm' | 'md' | 'lg'

// A filled text input.
//
// "Filled, not outlined — the fill is what makes an input findable on a dark
// plane." That is the design's rule, and it is why the fill is bg3 rather than
// transparent-with-a-border.
//
// It does NOT mean borderless, though the mockups draw it that way, and the
// difference is measured: bg3 is 1.10:1 against the content plane, so on a dark
// ground the fill alone does not identify the control — WCAG 2.2 SC 1.4.11 wants
// 3:1 for that. So the resting state carries a hairline in --si-border (#8A9097,
// 3.51:1 on this fill), which is the deviation recorded in _tokens.scss.
//
// Placeholders describe SCOPE, never the control: "Filter in Personal…", not
// "Search". A placeholder that names the widget tells the user nothing they
// cannot see.
//
// `lg` (48px) exists for exactly one caller — the search page's field, which the
// design calls "the only oversized input in the product, because it is the page's
// subject". Do not reach for it elsewhere.
@Component({
  selector: 'app-v2-input',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconV2Component],
  template: `
    <div class="inp" [class]="'inp--' + size()" [class.inp--error]="!!error()" [class.inp--disabled]="disabled()">
      @if (icon()) {
        <app-v2-icon class="inp__icon" [name]="icon()!" [size]="iconPx()" />
      }
      <input
        #field
        class="inp__field"
        [type]="type()"
        [value]="value()"
        [placeholder]="placeholder()"
        [disabled]="disabled()"
        [attr.aria-label]="ariaLabel()"
        [attr.aria-invalid]="error() ? 'true' : null"
        [attr.aria-describedby]="error() ? errorId : null"
        (input)="onInput($event)"
        (keydown.enter)="submitted.emit(value())"
        (keydown.escape)="onEscape()"
      />
      <!-- Trailing slot, inside the field's boundary and before the clear button.
           One caller: the search page, whose 48px field carries the Name/Full-text
           segmented INSIDE it (D6). Projecting it keeps that screen on the real
           primitive — its measured hairline, focus ring and clear button — instead of
           rebuilding a 48px lookalike beside it. -->
      <ng-content select="[inputTrailing]" />
      @if (value() && clearable()) {
        <button type="button" class="inp__clear" [attr.aria-label]="clearLabel()" (click)="clear()">
          <app-v2-icon name="x" [size]="14" />
        </button>
      }
      @if (error()) {
        <app-v2-icon class="inp__error-icon" name="info" [size]="iconPx()" />
      } @else if (hint()) {
        <span class="inp__hint">{{ hint() }}</span>
      }
    </div>
    @if (error()) {
      <div class="inp__error" [id]="errorId" role="alert">{{ error() }}</div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .inp {
        display: flex;
        align-items: center;
        gap: var(--si-space-4);
        background: var(--si-bg3);
        border: 1px solid var(--si-border);
        border-radius: var(--si-r1);
        transition:
          border-color var(--si-dur-2) var(--si-ease-out),
          background var(--si-dur-2) var(--si-ease-out);
      }
      .inp:hover:not(.inp--disabled):not(.inp--error) {
        border-color: var(--si-fg-muted);
      }
      /* The ring is drawn on the wrapper, not the <input>, so the icons and the
         clear button sit inside it. :focus-within is what makes that work. */
      .inp:focus-within {
        border-color: var(--si-focus-ring);
        outline: 2px solid var(--si-focus-ring);
        outline-offset: 1px;
      }
      .inp--error {
        border-color: var(--si-rose-line);
      }
      .inp--disabled {
        background: var(--si-bg-band);
        border-color: var(--si-line);
      }

      .inp__field {
        flex: 1;
        min-width: 0;
        background: transparent;
        border: 0;
        outline: none;
        color: var(--si-fg);
        font-family: var(--si-sans);
        font-weight: 400;
        padding: 0;
      }
      /* type="search" draws a browser clear button of its own, which lands beside
         ours and gives the field two of them. The primitive owns the control, so it
         owns suppressing that. */
      .inp__field::-webkit-search-cancel-button {
        display: none;
      }
      /* muted, not tertiary, for the same reason .inp__hint below is: a placeholder
         sits on the bg3 fill, where tertiary measures 4.38. And a placeholder is not
         decorative in this product — several fields carry no visible label, so it is
         the only statement of what the field wants. */
      .inp__field::placeholder {
        color: var(--si-fg-muted);
      }
      /* Stays tertiary, and legitimately: a disabled field swaps its fill to
         bg-band (4.64), and SC 1.4.3 exempts an inactive control besides. Do not
         "fix" this one to muted — a disabled field that reads as brightly as an
         enabled one is the defect. */
      .inp__field:disabled {
        color: var(--si-fg-tertiary);
        cursor: not-allowed;
      }

      /* A glyph, not type: SC 1.4.11 asks 3:1 of it, and tertiary on the bg3 fill is
         4.38. Legal — see the exemptions listed with the tier in _tokens.scss. */
      .inp__icon {
        color: var(--si-fg-tertiary);
        flex: none;
        line-height: 0;
      }
      .inp:focus-within .inp__icon {
        color: var(--si-accent-ink);
      }
      .inp__error-icon {
        color: var(--si-rose-ink);
        flex: none;
        line-height: 0;
      }
      /* Shortcut hints are mono because a keystroke is machine vocabulary. */
      .inp__hint {
        flex: none;
        font-family: var(--si-mono);
        font-size: var(--si-text-3);
        /* muted, not tertiary: the hint sits on the input fill, where tertiary
           measured 3.89 in a dialog and 4.38 on the content plane. */
        color: var(--si-fg-muted);
        background: var(--si-bg5);
        border-radius: var(--si-r0);
        padding: 2px var(--si-space-3);
      }
      /* Also a glyph, so also 3:1 rather than 4.5 — see .inp__icon above. */
      .inp__clear {
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border: 0;
        border-radius: var(--si-r0);
        background: transparent;
        color: var(--si-fg-tertiary);
        cursor: pointer;
      }
      .inp__clear:hover {
        background: var(--si-bg5);
        color: var(--si-fg);
      }
      .inp__error {
        margin-top: var(--si-space-3);
        font-size: var(--si-text-6);
        color: var(--si-rose-ink);
      }

      .inp--sm {
        height: 32px;
        padding: 0 var(--si-space-5);
      }
      .inp--sm .inp__field {
        font-size: var(--si-text-7);
      }
      .inp--md {
        height: 36px;
        padding: 0 var(--si-space-6);
      }
      .inp--md .inp__field {
        font-size: var(--si-text-8);
      }
      .inp--lg {
        height: 48px;
        padding: 0 var(--si-space-7);
        border-radius: var(--si-r2);
      }
      .inp--lg .inp__field {
        font-size: var(--si-text-11);
      }
    `
  ]
})
export class InputComponent {
  readonly value = input<string>('')
  readonly placeholder = input<string>('')
  readonly size = input<InputSize>('md')
  readonly type = input<'text' | 'search' | 'password' | 'email' | 'url'>('text')
  readonly icon = input<IconV2Name | null>(null)
  /** Mono shortcut hint on the right, e.g. `⌘F`. Hidden while an error shows. */
  readonly hint = input<string | null>(null)
  readonly error = input<string | null>(null)
  readonly disabled = input<boolean>(false)
  readonly clearable = input<boolean>(false)
  readonly ariaLabel = input<string | null>(null)
  readonly clearLabel = input<string>('Clear')

  readonly changed = output<string>()
  readonly submitted = output<string>()
  readonly escaped = output<void>()

  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field')

  // Stable per instance so aria-describedby points at this input's own message.
  protected readonly errorId = `inp-err-${Math.abs(hashCounter())}`

  protected readonly iconPx = computed(() => (this.size() === 'lg' ? 17 : 15))

  focus(): void {
    this.field()?.nativeElement.focus()
  }

  protected onInput(e: Event): void {
    this.changed.emit((e.target as HTMLInputElement).value)
  }

  protected clear(): void {
    this.changed.emit('')
    this.focus()
  }

  protected onEscape(): void {
    if (this.value()) this.clear()
    else this.escaped.emit()
  }
}

// Monotonic id source. Not Math.random(): a stable, non-random id keeps SSR and
// the client agreeing, which matters because v2 components are SSR-guarded.
let idSeq = 0
function hashCounter(): number {
  return ++idSeq
}
