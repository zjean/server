import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core'
import { formatTimestamp } from '../utils/format-timestamp'

// A timestamp cell for the v2 lists: absolute date visible, relative phrasing in
// the tooltip. The reasoning for that split lives in ../utils/format-timestamp.ts;
// this component is the rendering half of it.
//
// It emits a real <time> element with a machine-readable `datetime`, which the
// thirteen `{{ f.mtime | amTimeAgo }}` cells it replaces did not — those were bare
// text in a <div>, so the date was invisible to anything that reads the document
// rather than looks at it.
//
// Type comes from the `.v2-mono-data` role rather than from local declarations.
// That role (mono, --si-text-6, tertiary) existed in _type.scss with ZERO call
// sites; a timestamp is the exact thing it was written for — "sizes, timestamps,
// counts, version numbers" — and it is mono because the division that governs
// v2's type is IBM Plex Sans for what a PERSON wrote, Plex Mono for what a SYSTEM
// produced.
//
// The role names --si-fg-tertiary, which is NOT legal as text on bg3 (4.37) or
// bg5 (4.06). That is handled by the container, not here: `.v2-card` and
// `.v2-file-row` re-point the tier for their subtree, so this component renders
// legibly on the content plane and inside a hovering row without knowing which it
// is in. Dropping one of these into a bg5 container that does NOT re-point would
// be a contrast defect — see the re-point note in styles/_card.scss.
@Component({
  selector: 'app-v2-timestamp',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (formatted(); as t) {
      <time class="v2-mono-data" [attr.datetime]="t.iso" [title]="t.tooltip">{{ t.label }}</time>
    }
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        flex-shrink: 0;
      }
      time {
        white-space: nowrap;
      }
    `
  ]
})
export class TimestampComponent {
  readonly ms = input<number | string | null | undefined>(null)

  // `now` is an input so a caller rendering a long list can pass one shared
  // instant, and so the boundary cases stay drivable from a test. It is read at
  // computation time rather than captured at construction, so a component that
  // outlives a day boundary re-renders correctly when its inputs change.
  readonly now = input<number | null>(null)

  protected readonly formatted = computed(() => formatTimestamp(this.ms(), this.now() ?? Date.now()))
}
