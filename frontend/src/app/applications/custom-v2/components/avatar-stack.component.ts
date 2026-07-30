import { ChangeDetectionStrategy, Component, computed, inject, Input, input } from '@angular/core'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { AvatarComponent, AvatarUser } from './avatar.component'

export interface AvatarStackUser extends AvatarUser {
  id: string | number
  // Optional display name. When present, hovering the stack reveals a
  // member-name tooltip (parity with the classic user-avatar-stack, upstream
  // 160ec664). Entries without a label are simply omitted from the tooltip.
  label?: string
}

@Component({
  selector: 'app-v2-avatar-stack',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, L10nTranslatePipe],
  template: `
    <div class="stack" [class.stack--tip]="labels().length > 0">
      @for (u of shown(); track u.id; let i = $index) {
        <div class="slot" [style.margin-left.px]="i === 0 ? 0 : -6">
          <app-v2-avatar [user]="u" [size]="size()" [ring]="ring()" />
        </div>
      }
      @if (extraCount() > 0) {
        <div
          class="extra"
          [style.width.px]="size()"
          [style.height.px]="size()"
          [style.border-radius.px]="size()"
          [style.font-size.px]="extraFontSize()"
          [style.box-shadow]="'0 0 0 2px ' + ring()"
        >
          +{{ extraCount() }}
        </div>
      }
      @if (labels().length > 0) {
        <span class="tip" role="tooltip">
          @for (name of labels(); track name) {
            <span class="tip__row">{{ name }}</span>
          }
          @if (hiddenCount() > 0) {
            <span class="tip__more">{{ 'v2_and_n_more' | translate: locale.language : { nb: hiddenCount() } }}</span>
          }
        </span>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        flex-shrink: 0;
      }
      .stack {
        display: flex;
        align-items: center;
      }
      .stack--tip {
        position: relative;
      }
      .extra {
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--si-bg4);
        color: var(--si-fg-muted);
        font-family: var(--si-sans);
        font-weight: 600;
        margin-left: -6px;
      }
      .tip {
        position: absolute;
        bottom: calc(100% + 8px);
        left: 0;
        z-index: var(--si-z-popover);
        display: flex;
        flex-direction: column;
        gap: var(--si-space-1);
        min-width: max-content;
        max-width: 240px;
        padding: var(--si-space-4) var(--si-space-5);
        background: var(--si-bg1);
        color: var(--si-fg);
        border: 1px solid var(--si-border);
        border-radius: var(--si-r1);
        box-shadow: var(--si-shadow2);
        font-family: var(--si-sans);
        font-size: var(--si-text-6);
        line-height: 1.35;
        text-align: left;
        white-space: nowrap;
        opacity: 0;
        visibility: hidden;
        transform: translateY(2px);
        transition:
          opacity 0.12s ease,
          transform 0.12s ease,
          visibility 0.12s;
        pointer-events: none;
      }
      .stack--tip:hover .tip {
        opacity: 1;
        visibility: visible;
        transform: translateY(0);
      }
      .tip__row {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .tip__more {
        margin-top: 1px;
        color: var(--si-fg-muted);
        font-size: var(--si-text-4);
      }
    `
  ]
})
export class AvatarStackComponent {
  readonly users = input.required<AvatarStackUser[]>()
  readonly size = input<number>(22)
  // Optional override for the overflow count. When provided (e.g. a space card
  // knows the total member count but only has avatar identities for managers),
  // the "+N" chip is computed against `total` instead of users.length.
  readonly total = input<number | undefined>(undefined)
  // Ring colour drawn around each avatar and the "+N" chip. Defaults to the
  // card surface; callers on a different surface (e.g. the admin Spaces table
  // rows, which sit on --si-bg2) pass their own so the ring stays invisible.
  readonly ring = input<string>('var(--si-bg3)')
  @Input() max = 3
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  readonly shown = computed(() => this.users().slice(0, this.max))
  readonly extraCount = computed(() => {
    const total = this.total()
    const visible = this.shown().length
    return total === undefined ? Math.max(0, this.users().length - visible) : Math.max(0, total - visible)
  })
  // Floored at 10px. The bare size*0.4 produced 8.8px at the default size of 22
  // — the smallest text anywhere in v2, and a value no type scale would ever
  // contain because it is computed rather than chosen (#399). 10px is the
  // smallest size the rest of the app uses.
  readonly extraFontSize = computed(() => Math.max(10, Math.round(this.size() * 0.4 * 10) / 10))

  // Names surfaced in the hover tooltip — only the identities we actually have.
  readonly labels = computed(() =>
    this.users()
      .map((u) => u.label?.trim())
      .filter((l): l is string => !!l)
  )
  // Members counted in `total` for which we hold no named identity (e.g. a
  // Space card knows the member count but only joins manager names).
  readonly hiddenCount = computed(() => {
    const total = this.total()
    if (total === undefined) return 0
    return Math.max(0, total - this.labels().length)
  })
}
