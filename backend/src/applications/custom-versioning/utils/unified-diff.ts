// Hand-rolled unified diff. No dependency: `backend/package.json` ships no
// diff library, and ADR §16 keeps it that way rather than adding one for a
// single read-only endpoint.
//
// ALGORITHM CHOICE, stated plainly because the naive reading looks wrong.
// This trims the common prefix and suffix, then runs a classic
// longest-common-subsequence DP over what is left. LCS DP is O(n*m), which
// would be hopeless on two large unrelated files — but the trim is what makes
// it practical, because the realistic input here is two revisions of the same
// document where all but a few lines are identical. When the differing middle
// is still too large the function refuses rather than allocating a huge matrix,
// and the caller turns that into an HTTP error. A Myers O(ND) implementation
// would handle more cases, but it is ~100 lines of index arithmetic that is
// easy to get subtly wrong, and this endpoint renders text for a human.

// Max cells in the DP matrix (~4M => a few tens of MB worst case). Beyond this
// the two revisions have diverged so much that a line diff is not useful
// reading anyway.
const MAX_DP_CELLS = 4_000_000

// Lines of unchanged context kept around each change, and the gap below which
// two nearby changes are merged into one hunk (2 * context).
const CONTEXT_LINES = 3

export interface UnifiedDiffResult {
  diff: string
  // True when the two sides are byte-identical after line splitting.
  identical: boolean
}

export class DiffTooLargeError extends Error {
  constructor() {
    super('The two revisions differ too much to diff')
  }
}

interface EditOp {
  kind: 'eq' | 'del' | 'ins'
  line: string
}

// Splits on \n and keeps no trailing empty element for a file ending in a
// newline, so "a\n" and "a" produce the same single line — a trailing-newline
// change is not worth a diff hunk.
function toLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function unifiedDiff(oldText: string, newText: string, oldLabel: string, newLabel: string): UnifiedDiffResult {
  const a = toLines(oldText)
  const b = toLines(newText)

  // Trim the identical head and tail. This is what keeps the DP below tractable
  // for the normal case (one edit in a long file).
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++

  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)

  if (!midA.length && !midB.length) {
    return { diff: '', identical: true }
  }
  if ((midA.length + 1) * (midB.length + 1) > MAX_DP_CELLS) {
    throw new DiffTooLargeError()
  }

  const ops: EditOp[] = [
    ...a.slice(0, head).map((line): EditOp => ({ kind: 'eq', line })),
    ...diffMiddle(midA, midB),
    ...a.slice(a.length - tail).map((line): EditOp => ({ kind: 'eq', line }))
  ]

  return { diff: render(ops, oldLabel, newLabel), identical: false }
}

// LCS over the trimmed middle, walked back into an edit script.
function diffMiddle(a: string[], b: string[]): EditOp[] {
  const n = a.length
  const m = b.length
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const ops: EditOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'eq', line: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: 'del', line: a[i] })
      i++
    } else {
      ops.push({ kind: 'ins', line: b[j] })
      j++
    }
  }
  while (i < n) ops.push({ kind: 'del', line: a[i++] })
  while (j < m) ops.push({ kind: 'ins', line: b[j++] })
  return ops
}

// Standard unified-diff rendering: a header, then @@ hunks carrying
// CONTEXT_LINES of unchanged lines either side of each change.
function render(ops: EditOp[], oldLabel: string, newLabel: string): string {
  const changed = ops.map((op) => op.kind !== 'eq')
  // Which ops belong to a hunk: any change, plus CONTEXT_LINES around it.
  const keep = new Array<boolean>(ops.length).fill(false)
  for (let i = 0; i < ops.length; i++) {
    if (!changed[i]) continue
    for (let k = Math.max(0, i - CONTEXT_LINES); k <= Math.min(ops.length - 1, i + CONTEXT_LINES); k++) keep[k] = true
  }

  const out: string[] = [`--- a/${oldLabel}`, `+++ b/${newLabel}`]
  let idx = 0
  let oldLine = 1
  let newLine = 1
  while (idx < ops.length) {
    if (!keep[idx]) {
      if (ops[idx].kind !== 'ins') oldLine++
      if (ops[idx].kind !== 'del') newLine++
      idx++
      continue
    }
    // One hunk: consume while the ops stay in scope.
    const hunkOldStart = oldLine
    const hunkNewStart = newLine
    const body: string[] = []
    let oldCount = 0
    let newCount = 0
    while (idx < ops.length && keep[idx]) {
      const op = ops[idx]
      if (op.kind === 'eq') {
        body.push(` ${op.line}`)
        oldCount++
        newCount++
        oldLine++
        newLine++
      } else if (op.kind === 'del') {
        body.push(`-${op.line}`)
        oldCount++
        oldLine++
      } else {
        body.push(`+${op.line}`)
        newCount++
        newLine++
      }
      idx++
    }
    out.push(`@@ -${hunkOldStart},${oldCount} +${hunkNewStart},${newCount} @@`)
    out.push(...body)
  }
  return out.join('\n')
}
