import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core'

type DiffLineKind = 'add' | 'remove' | 'hunk' | 'header' | 'context'

interface DiffLine {
  readonly n: number
  readonly kind: DiffLineKind
  readonly text: string
}

/**
 * Renders a unified diff produced by `GET versions/diff/...`.
 *
 * Presentational only — the panel owns fetching, loading and error states. The
 * classification below is the whole of the logic, and it is deliberately
 * prefix-based rather than a parse: the backend emits a plain unified diff
 * (`custom-versioning/utils/unified-diff.ts`), and treating an unrecognized
 * line as context is the safe default — a mis-styled line is a cosmetic bug,
 * whereas a parser that throws would blank the comparison.
 */
@Component({
  selector: 'app-v2-versions-diff',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // NOT a <pre>. Each line is its own block with `white-space: pre`, so
  // indentation is preserved without the container preserving the template's own
  // newlines — inside a <pre> the newline between two block spans renders as an
  // extra blank line, which double-spaced the whole diff. In a normal container
  // that whitespace generates no box at all, so the markup can stay readable.
  template: `
    <div class="vd" role="group">
      <div class="vd__body">
        @for (l of lines(); track l.n) {
          <span class="vd__line" [class]="'vd__line--' + l.kind">{{ l.text }}</span>
        }
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
      }
      .vd {
        border: 1px solid var(--si-line);
        border-radius: var(--si-r2);
        background: var(--si-bg3);
        overflow: hidden;
      }
      .vd__body {
        margin: 0;
        padding: 8px 0;
        /* A diff must never widen the panel: long lines scroll inside this box
           rather than pushing the inspector's layout sideways. */
        overflow-x: auto;
        max-height: 420px;
        overflow-y: auto;
        font-family: var(--si-mono);
        font-size: var(--si-text-5);
        line-height: 1.5;
        color: var(--si-fg);
      }
      .vd__line {
        display: block;
        padding: 0 10px;
        /* Preserves the diff's own indentation. Deliberately on the line, not on
           the container — see the template comment. */
        white-space: pre;

        &--add {
          background: var(--si-green-soft);
          color: var(--si-green);
        }
        &--remove {
          background: var(--si-rose-soft);
          color: var(--si-rose);
        }
        &--hunk {
          color: var(--si-cyan);
        }
        &--header {
          color: var(--si-fg-faint);
        }
      }
    `
  ]
})
export class VersionsDiffComponent {
  readonly diff = input.required<string>()

  protected readonly lines = computed<DiffLine[]>(() => {
    const raw = this.diff()
    if (!raw) return []
    // A unified diff ends with a newline, which would otherwise render as a
    // trailing blank row.
    const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw
    return text.split('\n').map((line, i) => ({ n: i, kind: classify(line), text: line }))
  })
}

function classify(line: string): DiffLineKind {
  // Order matters: `---`/`+++` are file headers and start with the same
  // characters as removed/added lines, so they must be tested first.
  if (line.startsWith('---') || line.startsWith('+++')) return 'header'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'remove'
  return 'context'
}
