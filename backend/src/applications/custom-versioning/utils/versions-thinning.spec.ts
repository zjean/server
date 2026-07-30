import { THINNING_BANDS, ThinnableVersion, versionsToExpire } from './versions-thinning'

// Nextcloud's curve, verbatim (apps/files_versions/lib/Storage.php:69-81). These
// numbers are a THIRD PARTY's contract, so they are pinned rather than derived.
describe('THINNING_BANDS', () => {
  it('is Nextcloud\'s six bands in ascending order', () => {
    expect(THINNING_BANDS.map((b) => [b.endsAfterSeconds, b.stepSeconds])).toEqual([
      [10, 2],
      [60, 10],
      [3600, 60],
      [86400, 3600],
      [2592000, 86400],
      [Number.POSITIVE_INFINITY, 604800]
    ])
  })
})

const NOW = 10_000_000_000

// `secondsAgo` is how old the version's CONTENT is, which is what mtime means.
const at = (id: number, secondsAgo: number, label: string | null = null): ThinnableVersion => ({
  id,
  mtime: NOW - secondsAgo * 1000,
  label
})

describe('versionsToExpire', () => {
  it('expires nothing when there is nothing to expire', () => {
    expect(versionsToExpire([], NOW)).toEqual([])
    expect(versionsToExpire([at(1, 5)], NOW)).toEqual([])
  })

  // The newest version is always kept: it is the most recent recoverable state,
  // and NC anchors its own walk on it the same way.
  it('always keeps the newest unlabeled version, however old', () => {
    expect(versionsToExpire([at(1, 5_000_000)], NOW)).toEqual([])
  })

  // THE REGRESSION FROM THE REPORT. Two deliberate Ctrl+S saves 34 s apart, both
  // now older than a minute, so both sit in the 60 s-step band.
  it('collapses two versions 34s apart once they are in the 60s band', () => {
    expect(versionsToExpire([at(1, 120), at(2, 154)], NOW)).toEqual([2])
  })

  // The same pair while they are still fresh: the 2 s band keeps both, which is
  // the "every Ctrl+S is recoverable while you work" property.
  it('keeps versions 5s apart while both are inside the 10s band', () => {
    expect(versionsToExpire([at(1, 1), at(2, 6)], NOW)).toEqual([])
  })

  it('keeps a pair spaced wider than the band step', () => {
    expect(versionsToExpire([at(1, 120), at(2, 240)], NOW)).toEqual([])
  })

  // A labeled version is invisible to the walk: it is neither expired nor used
  // as a spacing anchor, so an unlabeled neighbour survives. Erring toward
  // keeping is the right direction for a rule that deletes user history.
  it('never expires a labeled version and does not anchor spacing on one', () => {
    const rows = [at(1, 120), at(2, 121, 'pinned'), at(3, 122)]
    const expired = versionsToExpire(rows, NOW)
    expect(expired).not.toContain(2)
    expect(expired).toEqual([3])
  })

  it('expires nothing when every version but one is labeled', () => {
    expect(versionsToExpire([at(1, 10), at(2, 20, 'a'), at(3, 30, 'b')], NOW)).toEqual([])
  })

  // Bands are selected per version by ITS OWN age, so one list can span several.
  it('applies the band belonging to each version, across a span of bands', () => {
    const rows = [
      at(1, 5), // 2s band, newest -> anchor
      at(2, 8), // 2s band, 3s after anchor -> kept
      at(3, 9), // 2s band, 1s after id 2 -> expired
      at(4, 4000), // 3600s band, far from id 2 -> kept
      at(5, 4100) // 3600s band, 100s after id 4, needs 3600 -> expired
    ]
    expect(versionsToExpire(rows, NOW)).toEqual([3, 5])
  })

  // Input order must not matter: callers pass whatever the query returned.
  it('is independent of input ordering', () => {
    const rows = [at(2, 154), at(1, 120)]
    expect(versionsToExpire(rows, NOW)).toEqual([2])
  })

  // Idempotence is what makes the nightly rule cheap after eager thinning has
  // already shaped a file (spec §5).
  it('is idempotent — re-running over the survivors expires nothing', () => {
    const rows = [at(1, 120), at(2, 154), at(3, 200)]
    const firstPass = versionsToExpire(rows, NOW)
    const survivors = rows.filter((r) => !firstPass.includes(r.id))
    expect(versionsToExpire(survivors, NOW)).toEqual([])
  })
})
