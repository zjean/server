// Time-grouping for the v2 activity lists.
//
// Recents already grouped by date, with a three-rung ladder — today / yesterday /
// earlier. The problem with three rungs is not that it is coarse, it is that the
// bottom rung is unbounded: any dataset whose newest row is more than two days
// old collapses entirely into "Earlier", so the grouping renders as a single
// header over every row and communicates nothing. That is the state the screen
// was actually in — one bucket, sixteen rows — and it is the common state, since
// a Recents list is only densely recent on an actively-used instance.
//
// Five rungs, with the two new ones covering the range a file manager is
// normally read at. Now a fortnight-old import lands under "This month" beside
// rows that say "3 Aug", instead of under "Earlier" beside rows that all say
// "14 days ago".
//
// The two middle rungs are ROLLING windows (last 7 / last 30 days), not calendar
// week and month. Calendar boundaries make the grouping jump for reasons the user
// cannot see — a file touched on Sunday leaves "This week" overnight, and on the
// 1st of a month "This month" empties completely while the rows themselves have
// not changed. A rolling window is the behaviour someone scanning a recents list
// actually predicts.

export type DateBucketKey = 'today' | 'yesterday' | 'thisWeek' | 'thisMonth' | 'earlier'

// i18n keys, resolved by the consuming template. Plain English literals matching
// the fork's convention for short static strings (see CLAUDE.md § i18n).
export const DATE_BUCKET_LABELS: Record<DateBucketKey, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  thisWeek: 'This week',
  thisMonth: 'This month',
  earlier: 'Earlier'
}

// Newest first. Consumers render in this order, so it is the display order and
// not merely a type-level list.
export const DATE_BUCKET_ORDER: readonly DateBucketKey[] = ['today', 'yesterday', 'thisWeek', 'thisMonth', 'earlier'] as const

const DAY_MS = 24 * 60 * 60 * 1000

export function dateBucketOf(ms: number, now: number): DateBucketKey {
  // A non-finite timestamp sorts to the oldest bucket rather than throwing or
  // creating a sixth "unknown" group. This mirrors what the screen did before and
  // is the right call for a value that is missing rather than wrong: an
  // "Unknown" header would be a more prominent statement about a row than the
  // row itself carries.
  if (!Number.isFinite(ms)) return 'earlier'

  const reference = new Date(now)
  const startOfToday = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate()).getTime()

  // A FUTURE timestamp belongs in the newest bucket, not the oldest. It arises
  // for a real reason rather than a hypothetical one: `mtime` is client-supplied
  // (sync clients set it via `touchFile`), so a device with a skewed clock
  // produces rows dated ahead of the server. Falling through the `>=` ladder
  // would put them in 'today' anyway, but only by accident — the explicit branch
  // is what stops a later edit to the ladder from silently filing tomorrow's
  // file under "Earlier".
  if (ms >= startOfToday) return 'today'
  if (ms >= startOfToday - DAY_MS) return 'yesterday'
  // Bounds are measured from the start of today, so a bucket's membership does
  // not shift as the current day advances.
  if (ms >= startOfToday - 6 * DAY_MS) return 'thisWeek'
  if (ms >= startOfToday - 29 * DAY_MS) return 'thisMonth'
  return 'earlier'
}

export interface DateBucket<T> {
  key: DateBucketKey
  // i18n key, not a translated string — the caller owns the locale.
  label: string
  items: T[]
}

// Groups while preserving the incoming order within each bucket, and emits only
// non-empty buckets. Order preservation matters because the caller has already
// sorted by recency and the grouping must not re-order inside a group.
export function groupByDateBucket<T>(items: readonly T[], msOf: (item: T) => number, now: number): DateBucket<T>[] {
  const byKey = new Map<DateBucketKey, T[]>()

  for (const item of items) {
    const key = dateBucketOf(msOf(item), now)
    const bucket = byKey.get(key)
    if (bucket) bucket.push(item)
    else byKey.set(key, [item])
  }

  // Driven by DATE_BUCKET_ORDER rather than by Map insertion order: insertion
  // order reflects the data's order, which is only coincidentally chronological.
  return DATE_BUCKET_ORDER.filter((key) => byKey.has(key)).map((key) => ({
    key,
    label: DATE_BUCKET_LABELS[key],
    items: byKey.get(key)!
  }))
}
