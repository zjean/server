// Age-tiered thinning of a file's version history.
//
// A PURE function on purpose: the curve is the part with real risk, and keeping
// it free of the DB and of NestJS is what lets every band and boundary be
// covered exhaustively for the cost of an array literal. The two call sites
// (VersioningService's eager pass, VersionsRetention's nightly rule) supply rows
// and delete what comes back.
//
// The bands are NEXTCLOUD'S, verbatim — `apps/files_versions/lib/Storage.php`
// lines 69-81 of `nextcloud/server`. Adopted rather than tuned: it is a proven
// curve, this fork already mirrors NC for the mobile surface, and inventing our
// own numbers would be bikeshedding with no evidence behind it.
export const THINNING_BANDS: readonly { endsAfterSeconds: number; stepSeconds: number }[] = [
  // first 10s, one version every 2s
  { endsAfterSeconds: 10, stepSeconds: 2 },
  // next minute, one version every 10s
  { endsAfterSeconds: 60, stepSeconds: 10 },
  // next hour, one version every minute
  { endsAfterSeconds: 3600, stepSeconds: 60 },
  // next 24h, one version every hour
  { endsAfterSeconds: 86400, stepSeconds: 3600 },
  // next 30 days, one version every day
  { endsAfterSeconds: 2592000, stepSeconds: 86400 },
  // beyond that, one version per week
  { endsAfterSeconds: Number.POSITIVE_INFINITY, stepSeconds: 604800 }
]

// What the thinner needs from a version row. `mtime` is in MILLISECONDS, as the
// column stores it.
export interface ThinnableVersion {
  id: number
  mtime: number
  label: string | null
  // When WE captured this version. Server-set and monotonic, unlike `mtime`,
  // which arrives from the client via touchFile — see the floor in
  // versionsToExpire for what that difference is load-bearing for.
  createdAt: Date
}

// The ids to expire, given a file's versions and the current time.
//
// Spacing keys on `mtime`, not `createdAt`: mtime is the timeline of distinct
// content states and is what the version panel displays, so the survivors read
// as evenly spaced to the user. `createdAt` would bunch a burst of captures
// whose contents actually span days. Banding is not this simple — see the
// max() below for why it keys on whichever clock says the row is older.
//
// Labeled versions are filtered out ENTIRELY rather than merely skipped — they
// are neither expired nor used as a spacing anchor. An unlabeled version sitting
// next to a labeled one therefore survives, which errs toward keeping history;
// the right direction for a rule whose failure mode is deleting a user's data.
export function versionsToExpire(versions: ThinnableVersion[], nowMs: number): number[] {
  const candidates = versions.filter((v) => v.label === null).sort((a, b) => b.mtime - a.mtime)
  const expire: number[] = []
  let lastKeptMtime: number | null = null
  for (const version of candidates) {
    if (lastKeptMtime === null) {
      // The newest is always kept: it is the most recent recoverable state, and
      // it is the anchor the rest of the walk measures from.
      lastKeptMtime = version.mtime
      continue
    }
    // Banded by whichever clock says the row is OLDER, never by mtime alone.
    // `mtime` is client-controlled (touchFile), so a forward-skewed sync client
    // can stamp a row with a mtime ahead of `nowMs` — a NEGATIVE age, which
    // `stepForAge`'s `<=` comparison matches against band 1 forever. Without the
    // max(), such a row is judged at band 1's 2s spacing for its whole life and
    // never thins: with retentionDays off and no quota configured (both
    // defaults), the row count for that one file then grows at the coalescing
    // rate with nothing to bound it, exactly the unbounded growth the FIFO cap
    // used to prevent. `createdAt` is server-set and never rewinds, so
    // `nowMs - createdAt` is always a true, non-negative age and puts a ceiling
    // under the mtime-derived age.
    //
    // This preserves banding-on-mtime for every honest row: a BACKDATED mtime
    // (the case the floor below exists for) has `age_mtime > age_createdAt`, so
    // mtime still governs, exactly as before. Only a future-skewed mtime is
    // affected, and only in the direction of "band by the truthful age instead
    // of a fabricated one" — never the reverse.
    //
    // This is also what makes `byFileIdNewestFirst` safe to leave UNPAGED
    // (versioning-queries.service.ts:274-276 — "the row count for one file is
    // bounded by the thinner itself on every write"): that claim is exactly what
    // an unbounded band-1 row would falsify.
    const step = stepForAge(Math.max(nowMs - version.mtime, nowMs - version.createdAt.getTime()) / 1000)
    // THE FLOOR. Never expire a capture we have not held for at least as long as
    // the spacing we are judging it by. `mtime` is client-controlled, so without
    // this a row whose content carries a backdated mtime lands in a coarse band
    // and is expired inside the same snapshot() call that created it — silently
    // and unrecoverably, while the caller logs `versioned …`. `createdAt` is set
    // by us and never rewinds. No new constant: the floor IS the curve, read
    // against a clock we trust.
    //
    // An exempt row still anchors, because it is being kept — and anchoring on it
    // keeps MORE neighbours, which is the safe direction for a rule that deletes
    // a user's history.
    if ((nowMs - version.createdAt.getTime()) / 1000 < step) {
      lastKeptMtime = version.mtime
      continue
    }
    if ((lastKeptMtime - version.mtime) / 1000 >= step) {
      lastKeptMtime = version.mtime
    } else {
      expire.push(version.id)
    }
  }
  return expire
}

// The band a version's own age falls in. Bands are ascending, so the first
// match wins; the last is unbounded, so the loop always returns.
function stepForAge(ageSeconds: number): number {
  for (const band of THINNING_BANDS) {
    if (ageSeconds <= band.endsAfterSeconds) return band.stepSeconds
  }
  return THINNING_BANDS[THINNING_BANDS.length - 1].stepSeconds
}
