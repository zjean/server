import { dJs } from '../../../common/utils/time'

// One spelling of "when did this happen" for every v2 list.
//
// Thirteen v2 templates piped `mtime | amTimeAgo` straight into a cell, which
// reads well for something that happened minutes ago and carries almost nothing
// once the data is older: a Recents screen holding twenty files that were all
// touched in the same import rendered the string "14 days ago" sixteen times.
// Sixteen rows, one bit of information, and no way to tell any of them apart.
//
// So the VISIBLE value is absolute and the relative phrasing moves to the
// tooltip. Absolute dates differentiate — that is the whole point — and they are
// also what makes the date buckets in ./date-buckets.ts legible, since a bucket
// head saying "This month" over rows that each name a day is a summary, whereas
// one over sixteen identical relative strings is a restatement.
//
// The year is omitted within the current year and shown outside it. That is not
// a cosmetic saving: a column of "3 Aug" reads as a date, and the same column
// with "3 Aug 2026" on every line reads as a serial number, so the year earns
// its space only when it is actually distinguishing something.
//
// dayjs rather than Intl, because dayjs is what the app already localises. The
// locale bundles are loaded per language in `i18n/lib/dayjs.i18n.ts`, so `MMM`
// and `LLL` come out Dutch on a Dutch session with no work here. Reaching for
// `Intl.DateTimeFormat` would have introduced a second, separately-configured
// formatting stack for the same strings.
export interface FormattedTimestamp {
  // The absolute date, for the cell. Mono at the call site (`.v2-mono-data`).
  label: string
  // Relative phrasing plus the full date and time, for `title`. Both, because
  // the relative half is the thing the visible label gives up, and the absolute
  // half is what makes the tooltip useful for a file touched months ago.
  tooltip: string
  // Machine-readable value for <time datetime>.
  iso: string
}

// `now` is a parameter rather than a `Date.now()` call inside the body so the
// spec can pin every boundary without freezing the clock globally.
export function formatTimestamp(value: number | string | null | undefined, now: number = Date.now()): FormattedTimestamp | null {
  // A missing timestamp is a real state — `mtime` is absent on a row the server
  // has not materialised yet — and it must render as nothing rather than as
  // "Invalid Date". Note `0` is deliberately NOT treated as missing here: it is
  // a valid epoch instant, and the check is written against null/undefined/''
  // rather than falsiness for exactly that reason.
  if (value === null || value === undefined || value === '') return null

  // An all-digits string is EPOCH MILLIS, not a date string, and dayjs does not
  // guess that: handed "1785748925114" it runs the value through Date parsing and
  // returns 4 Feb 1791. So a payload that carries mtime as a string — which is
  // why the existing bucket code says `Number(f.mtime)` rather than trusting the
  // declared type — would render a plausible, silently wrong 18th-century date.
  // Coerce those, and only those: a genuine ISO 8601 string must still reach
  // dayjs intact, so the test is "digits only", not "parses as a number".
  const at = dJs(typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value)
  if (!at.isValid()) return null

  const reference = dJs(now)
  const sameYear = at.year() === reference.year()

  return {
    label: sameYear ? at.format('D MMM') : at.format('D MMM YYYY'),
    tooltip: `${at.from(reference)} · ${at.format('LLL')}`,
    iso: at.toISOString()
  }
}
