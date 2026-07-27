import { DiffTooLargeError, unifiedDiff } from './unified-diff'

// Applies a unified diff's hunks back onto the old text and checks we land on
// the new text. This is the property that matters — a diff that renders
// plausibly but does not describe the change is worse than no diff.
function applyDiff(oldText: string, diff: string): string {
  const oldLines = oldText.split('\n')
  if (oldLines[oldLines.length - 1] === '') oldLines.pop()
  const out: string[] = []
  let cursor = 0 // 0-based index into oldLines

  const lines = diff.split('\n')
  let i = 0
  while (i < lines.length) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(lines[i])
    if (!header) {
      i++
      continue
    }
    const oldStart = Number(header[1]) - 1
    // Copy untouched lines before this hunk.
    while (cursor < oldStart) out.push(oldLines[cursor++])
    i++
    while (i < lines.length && !lines[i].startsWith('@@')) {
      const l = lines[i]
      if (l.startsWith(' ')) {
        out.push(l.slice(1))
        cursor++
      } else if (l.startsWith('-')) {
        cursor++
      } else if (l.startsWith('+')) {
        out.push(l.slice(1))
      }
      i++
    }
  }
  while (cursor < oldLines.length) out.push(oldLines[cursor++])
  return out.join('\n')
}

describe('unifiedDiff', () => {
  it('reports identical content without emitting a diff', () => {
    expect(unifiedDiff('a\nb\nc\n', 'a\nb\nc\n', 'old', 'new')).toEqual({ diff: '', identical: true })
  })

  it('treats a trailing-newline-only difference as identical', () => {
    // Not worth a hunk, and every editor disagrees about it.
    expect(unifiedDiff('a\nb', 'a\nb\n', 'old', 'new').identical).toBe(true)
  })

  it('emits a header and a hunk for a single changed line', () => {
    const { diff, identical } = unifiedDiff('one\ntwo\nthree\n', 'one\nTWO\nthree\n', 'v1', 'current')
    expect(identical).toBe(false)
    expect(diff.split('\n').slice(0, 2)).toEqual(['--- a/v1', '+++ b/current'])
    expect(diff).toContain('-two')
    expect(diff).toContain('+TWO')
    expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/)
  })

  it.each([
    ['a line changed in the middle', 'a\nb\nc\nd\ne\n', 'a\nb\nX\nd\ne\n'],
    ['a line inserted', 'a\nb\nc\n', 'a\nb\nbb\nc\n'],
    ['a line deleted', 'a\nb\nc\n', 'a\nc\n'],
    ['content appended', 'a\nb\n', 'a\nb\nc\nd\n'],
    ['content prepended', 'c\nd\n', 'a\nb\nc\nd\n'],
    ['everything replaced', 'a\nb\nc\n', 'x\ny\nz\n'],
    ['emptied', 'a\nb\n', ''],
    ['filled from empty', '', 'a\nb\n'],
    ['two distant edits', 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n', 'A\nb\nc\nd\ne\nf\ng\nh\ni\nj\nK\n'],
    ['a duplicated line removed', 'x\nx\nx\n', 'x\nx\n']
  ])('round-trips: %s', (_label, oldText, newText) => {
    const { diff } = unifiedDiff(oldText, newText, 'old', 'new')
    const expected = newText.endsWith('\n') ? newText.slice(0, -1) : newText
    expect(applyDiff(oldText, diff)).toBe(expected)
  })

  it('keeps three lines of context around a change in a long file', () => {
    const oldText = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
    const newText = oldText.replace('line 100', 'CHANGED')
    const { diff } = unifiedDiff(oldText, newText, 'old', 'new')

    expect(diff).toContain(' line 97')
    expect(diff).toContain(' line 103')
    // The untouched bulk of the file is not shipped.
    expect(diff).not.toContain('line 50')
    expect(applyDiff(oldText, diff)).toBe(newText)
  })

  it('reports hunk line numbers a patch tool would accept', () => {
    const oldText = 'a\nb\nc\nd\ne\nf\ng\nh\n'
    const newText = 'a\nb\nc\nD\ne\nf\ng\nh\n'
    const { diff } = unifiedDiff(oldText, newText, 'old', 'new')
    // Change is at line 4 (1-based), so with 3 lines of context the hunk starts
    // at line 1 and covers 7 lines on each side.
    expect(diff).toContain('@@ -1,7 +1,7 @@')
  })

  // The trim is what keeps the LCS matrix small; without it this would be a
  // 20000x20000 allocation.
  it('handles a large file with one edit cheaply', () => {
    const oldText = Array.from({ length: 20_000 }, (_, i) => `row ${i}`).join('\n')
    const newText = oldText.replace('row 19999', 'row 19999 edited')
    const { diff } = unifiedDiff(oldText, newText, 'old', 'new')
    expect(diff).toContain('+row 19999 edited')
    expect(applyDiff(oldText, diff)).toBe(newText)
  })

  it('refuses when the differing middle is too large to diff', () => {
    // Two thousand-plus lines with nothing in common: the matrix would be huge
    // and a line diff would be unreadable anyway.
    const oldText = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join('\n')
    const newText = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join('\n')
    expect(() => unifiedDiff(oldText, newText, 'old', 'new')).toThrow(DiffTooLargeError)
  })
})
