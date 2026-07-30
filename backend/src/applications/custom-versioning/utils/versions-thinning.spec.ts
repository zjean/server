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
// `heldSeconds` DEFAULTS TO `secondsAgo` — i.e. an HONEST write, where createdAt
// and mtime name the same moment, so `stepForAge`'s `max(ageByMtime,
// ageByCreatedAt)` (versions-thinning.ts) collapses to the single age these
// band-selection cases already reason about. This is not an arbitrary choice:
// a fixed default (this used to be a flat one year, regardless of `secondsAgo`)
// would make every case with a small `secondsAgo` simulate mtime skewed far
// AHEAD of createdAt — precisely the future-mtime bug `max()` exists to correct
// — and band selection would then key off the year-old createdAt instead of the
// intended `secondsAgo`, moving these cases' expectations for a reason that has
// nothing to do with what they are testing. Pass `heldSeconds` explicitly only
// when a case is deliberately about the floor (a row held for less than its own
// band's step) or about the skew itself.
const at = (id: number, secondsAgo: number, label: string | null = null, heldSeconds = secondsAgo): ThinnableVersion => ({
  id,
  mtime: NOW - secondsAgo * 1000,
  label,
  createdAt: new Date(NOW - heldSeconds * 1000)
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

// A forward-skewed sync client (touchFile) can stamp `mtime` AHEAD of the
// server's `nowMs`, so `ageByMtime` is NEGATIVE. `stepForAge`'s `<=` comparison
// matches band 1 (the 2s step) for any negative age, so mtime-only banding pins
// such a row in the finest band forever — with retentionDays off and no quota
// configured (both defaults), nothing else bounds its row count, which is
// exactly what age-tiered thinning replaced the FIFO cap to avoid.
// `stepForAge(Math.max(ageByMtime, ageByCreatedAt))` (versions-thinning.ts)
// fixes this by falling back to the true, non-negative age derived from
// `createdAt` whenever it is the larger (i.e. "older-looking") of the two.
describe('versionsToExpire — future-skewed mtime', () => {
  it('bands by createdAt instead of pinning a future-mtime row in band 1 forever', () => {
    // Both rows were genuinely captured 40 days ago (createdAt), well past
    // band 6's 604800s step, but their (skewed) mtime claims they are barely
    // 100s apart (500_000ms - 400_000ms) and still in the future relative to
    // NOW. Mtime-only banding would put both in band 1 (any negative age
    // matches its "<= 10" check) and 100s of spacing clears that 2s step
    // easily, so the buggy code keeps both forever. The fix bands both by
    // their true createdAt age (band 6, 604800s step), under which 100s of
    // spacing is NOT enough, so the older of the two is expired.
    const heldSeconds = 3_456_000 // 40 days
    const rows: ThinnableVersion[] = [
      { id: 1, mtime: NOW + 500_000, label: null, createdAt: new Date(NOW - heldSeconds * 1000) },
      { id: 2, mtime: NOW + 400_000, label: null, createdAt: new Date(NOW - heldSeconds * 1000) }
    ]
    expect(versionsToExpire(rows, NOW)).toEqual([2])
  })

  // The floor still protects a row that was genuinely just captured, even
  // when its mtime is future-skewed: `ageByCreatedAt` is ~0, so `max()` picks
  // band 1 regardless of how far in the future mtime claims to be, and the
  // floor (held 0s < band 1's 2s step) exempts it exactly as it would an
  // honest fresh capture.
  //
  // Row 1 is given an even MORE future mtime purely so it — not row 2 — is the
  // sorted-newest and auto-kept as the walk's anchor unconditionally. That
  // isolates what this test is actually about: whether row 2, a mere 1s (well
  // under band 1's 2s step) behind that anchor, survives via the floor rather
  // than via the "newest is always kept" rule.
  it('still exempts a just-captured row via the floor, even with a future mtime', () => {
    const rows: ThinnableVersion[] = [
      { id: 1, mtime: NOW + 10_000, label: null, createdAt: new Date(NOW - 999_999 * 1000) },
      { id: 2, mtime: NOW + 9_000, label: null, createdAt: new Date(NOW) }
    ]
    expect(versionsToExpire(rows, NOW)).toEqual([])
  })
})

// mtime is CLIENT-CONTROLLED (touchFile), so it cannot be the only clock. The
// floor is keyed on createdAt, which the server sets and never rewinds.
describe('versionsToExpire — the createdAt floor', () => {
  // THE VECTOR. Content stamped 2 days ago, captured just now: without the floor
  // it lands in the 30-day band (86400s step), sits 30s from its neighbour, and
  // is expired inside the same snapshot() call that created it.
  it('never expires a row it has only just captured, however old the content claims to be', () => {
    const twoDays = 172_800
    const rows = [at(1, twoDays, null, 31_536_000), at(2, twoDays + 30, null, 0)]
    expect(versionsToExpire(rows, NOW)).toEqual([])
  })

  // The floor must not become a blanket exemption: once the row has been held
  // longer than the step it is judged by, it thins normally.
  //
  // NOTE: at this age (~2 days), row 2's own band is the 30-day/86400s-step
  // band (THINNING_BANDS[4]), not the 24h/3600s-step band — so the held value
  // must clear 86400s, not 3600s, to actually exercise "held past its band
  // step". 90_000s (25h) does; 7200s (2h) would not, and the test would then
  // assert an exemption instead of an expiry.
  it('expires the same row once it has been held past its band step', () => {
    const twoDays = 172_800
    const rows = [at(1, twoDays, null, 31_536_000), at(2, twoDays + 30, null, 90_000)]
    expect(versionsToExpire(rows, NOW)).toEqual([2])
  })

  // An exempt row is KEPT, so it anchors — which keeps its neighbour too. The
  // conservative direction, and the one that cannot cause surprise deletions.
  it('lets an exempt row anchor spacing, keeping its neighbour as well', () => {
    const rows = [at(1, 3000, null, 31_536_000), at(2, 3030, null, 0), at(3, 3060, null, 31_536_000)]
    // id 2 is exempt (held 0s < 60s step, its own band from a 3030s mtime age)
    // and anchors at mtime NOW-3030s. id 3's heldSeconds of 31_536_000 makes
    // max() pick its createdAt age for banding, landing it in the final band
    // (604800s step), so it is NOT exempt (held far longer than 604800s) and
    // is judged against that step: 30s from the anchor is nowhere near
    // 604800s, so it goes.
    expect(versionsToExpire(rows, NOW)).toEqual([3])
  })

  // The reported regression must still hold: two deliberate saves 34s apart, both
  // long since captured, still collapse in the 60s band.
  it('still collapses the 34s-apart pair once both are long held', () => {
    expect(versionsToExpire([at(1, 120), at(2, 154)], NOW)).toEqual([2])
  })
})
