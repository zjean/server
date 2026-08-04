import { SPACE_ALIAS, SPACE_REPOSITORY } from '@sync-in-server/backend/src/applications/spaces/constants/spaces'
import type { FileContentModel } from '../../../files/models/file-content.model'
import { FileGlyphType } from '../../components/file-glyph.component'
import { mimeToGlyph } from '../../utils/mime-to-glyph'

/**
 * The pure half of the search screen: grouping, faceting and match highlighting.
 *
 * Separated from the component because all three are the parts that can be wrong
 * in a way rendering does not reveal — an off-by-one in a highlight range, a group
 * key that collapses two spaces into one, a time bucket that includes tomorrow.
 * `search-results.spec.ts` pins them.
 */

/** A file-type facet, one per glyph family present in the results. */
export type TypeFacet = 'all' | FileGlyphType

export type TimeFacet = 'any' | 'today' | 'week' | 'month'

export interface ResultGroup {
  /** Stable key: the repository + space alias the results share. */
  key: string
  /** What the group header prints — a space name when we know one, else the alias. */
  label: string
  rows: FileContentModel[]
}

/** One run of text, flagged when it is part of a query match. */
export interface Segment {
  text: string
  hit: boolean
}

/**
 * The space a result belongs to, as `<repository>/<alias>`.
 *
 * `FileContent.path` is the file's PARENT directory in Sync-in path form
 * (`files/personal/Documents`, `shares/design-review/assets`), so the first two
 * segments identify the space and everything after them is location within it.
 * Grouping on the alias alone would merge a space with a share that happens to
 * carry the same alias.
 */
export function spaceKey(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.slice(0, 2).join('/')
}

/**
 * Groups results by space, preserving the server's ordering.
 *
 * Insertion-ordered rather than sorted: the backend returns results by relevance
 * (then mtime), and re-sorting groups alphabetically would put the best match
 * under a header three screens down. The FIRST result decides which group leads.
 */
export function groupBySpace(rows: readonly FileContentModel[], nameFor: (key: string) => string): ResultGroup[] {
  const groups = new Map<string, ResultGroup>()
  for (const row of rows) {
    const key = spaceKey(row.path)
    const existing = groups.get(key)
    if (existing) existing.rows.push(row)
    else groups.set(key, { key, label: nameFor(key), rows: [row] })
  }
  return [...groups.values()]
}

/**
 * The label for a space key.
 *
 * `files/personal` is the user's own space and has a name of its own; anything
 * else is looked up by alias in the store's space list and falls back to the
 * alias, which is always meaningful — an unnamed alias reads as a slug, not as
 * blank. The result is passed through `translate` by the caller, which is identity
 * for a real space name and gives 'Personal' its translation.
 */
export function spaceLabel(key: string, spaces: readonly { alias: string; name: string }[]): string {
  const [repository, alias] = key.split('/')
  // A file at the repository root has a one-segment path and therefore no alias —
  // a directly-shared single file does exactly this, its parent being `shares`. It
  // is not a nameless space; it is the repository itself.
  if (!alias) return repository === SPACE_REPOSITORY.SHARES ? 'Shared' : 'Personal'
  if (alias === SPACE_ALIAS.PERSONAL) return 'Personal'
  return spaces.find((s) => s.alias === alias)?.name ?? alias
}

/** The glyph a group header carries: periwinkle for a space, per D3's identity rule. */
export function isSharesKey(key: string): boolean {
  return key.split('/')[0] === SPACE_REPOSITORY.SHARES
}

/** Every glyph family present in the results, in the order the design lists them. */
export function typeFacets(rows: readonly FileContentModel[]): FileGlyphType[] {
  const seen = new Set<FileGlyphType>()
  for (const row of rows) seen.add(mimeToGlyph(row.mime))
  return [...seen]
}

/**
 * Narrows the fetched results by type and age.
 *
 * These filter the page the server returned; they are NOT query parameters,
 * because `SearchFilesDto` has only `content`, `fullText` and `limit`. That makes
 * them honest as long as the count line describes what is on screen rather than
 * claiming a total — which is why the meta line counts the FILTERED rows.
 */
export function applyFacets(rows: readonly FileContentModel[], type: TypeFacet, time: TimeFacet, nowMs: number): FileContentModel[] {
  const floor = timeFloor(time, nowMs)
  return rows.filter((r) => (type === 'all' || mimeToGlyph(r.mime) === type) && (floor === null || r.mtime >= floor))
}

// `mtime` is client-controlled (sync clients set it), so a row can sit in the
// future. A future mtime passes every floor, which is the right failure: a
// filter's job is to hide what does not match, not to hide what looks odd.
function timeFloor(time: TimeFacet, nowMs: number): number | null {
  const day = 86_400_000
  switch (time) {
    case 'today':
      return nowMs - day
    case 'week':
      return nowMs - 7 * day
    case 'month':
      return nowMs - 30 * day
    default:
      return null
  }
}

/**
 * Splits `text` into runs, flagging the ones that match the query.
 *
 * Returns SEGMENTS rather than markup on purpose. The obvious implementation
 * wraps matches in `<span>` and binds the result with `innerHTML`, which makes
 * every file name on this screen an injection site — and file names are attacker
 * -controlled in any multi-user install. The template renders these with `@for`,
 * so the text never stops being text.
 *
 * Each whitespace-separated term of the query is matched independently and
 * case-insensitively, because the backend's LIKE search does the same.
 */
export function highlight(text: string, query: string): Segment[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
  if (terms.length === 0 || !text) return [{ text, hit: false }]

  const lower = text.toLowerCase()
  // Mark every matched character first, then coalesce. Doing it in one pass with
  // string slicing gets overlapping terms ("ver" and "version") wrong.
  const marks = new Array<boolean>(text.length).fill(false)
  for (const term of terms) {
    let from = 0
    for (;;) {
      const at = lower.indexOf(term, from)
      if (at === -1) break
      for (let i = at; i < at + term.length; i++) marks[i] = true
      from = at + term.length
    }
  }

  const segments: Segment[] = []
  let start = 0
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || marks[i] !== marks[start]) {
      segments.push({ text: text.slice(start, i), hit: marks[start] })
      start = i
    }
  }
  return segments
}

/**
 * Splits a backend snippet on its `<mark>` markers.
 *
 * The server highlights full-text matches for us — `files-content-store-mysql`
 * wraps each matched term in `<mark>…</mark>` before returning `matches[]` — so a
 * snippet arrives as a string with markup in it and re-highlighting it by query
 * would miss the stemming and context the server applied.
 *
 * Classic binds this with `[innerHTML]` (search.component.html:69). We parse it
 * into segments instead: the surrounding text is raw FILE CONTENT, which the
 * backend does not escape, so a document containing `<img onerror=…>` reaches the
 * browser as markup. Angular's sanitizer would defang the handler but still render
 * the element. Segments render it as the text it is.
 *
 * The cost is that a file containing the literal string `<mark>` gets a run
 * highlighted that was not a match. That is a strictly better failure than
 * rendering someone's file as UI.
 */
export function markSegments(snippet: string): Segment[] {
  const parts = snippet.split(/<mark>|<\/mark>/i)
  // split() on an alternation yields text, match, text, match… — odd indices are
  // the highlighted runs, because a `<mark>` always precedes what it marks.
  return parts.map((text, i) => ({ text, hit: i % 2 === 1 })).filter((seg) => seg.text.length > 0)
}
