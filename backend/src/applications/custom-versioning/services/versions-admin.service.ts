import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { FileError } from '../../files/models/file-error'
import { VERSIONS_ADMIN_TOP_ROOTS } from '../constants/versioning'
import {
  VersionsPurgeResult,
  VersionsRepointResult,
  VersionsRootKind,
  VersionsRootUsage,
  VersionsStorageSummary
} from '../interfaces/version.interface'
import { parseVersionsRoot } from '../utils/paths'
import { VersioningQueries } from './versioning-queries.service'
import { VersionsRetention } from './versions-retention.service'

// The operator's view of version storage, and the one action on it (#342).
//
// WHY IT EXISTS. `files.versions.enabled` is instance-wide and boolean, and
// version bytes are charged against USER QUOTA (ADR §7, quotaShare default
// 50%). Before this, an operator facing "I am out of space and I do not know
// why" had no instrument at all: no total, no ranking, and no way to purge one
// user's history short of direct DB and filesystem surgery — which is exactly
// the surgery ADR §9's pin-before-read discipline exists to make unnecessary.
//
// THIS SERVICE OWNS NO MECHANISM. Reads are the existing aggregates; the purge
// is VersionsRetention's, which is VersioningService's refcount-aware
// dropVersion. What it owns is the operator-facing SHAPE: validating a root
// string that arrived from a human, labelling a root as a user or a space, and
// attaching the ceiling that will actually be enforced. Anything that deletes
// belongs one layer down.
@Injectable()
export class VersionsAdminService {
  private readonly logger = new Logger(VersionsAdminService.name)

  constructor(
    private readonly queries: VersioningQueries,
    private readonly retention: VersionsRetention
  ) {}

  // Instance-wide totals plus the heaviest roots.
  //
  // Two queries, both indexed aggregates: one un-grouped pass for the totals and
  // one GROUP BY for the ranking. The totals are NOT summed from the ranking —
  // the ranking is truncated to a top-N, so summing it would report a total that
  // silently shrinks as an install grows.
  async storageSummary(limit = VERSIONS_ADMIN_TOP_ROOTS): Promise<VersionsStorageSummary> {
    const totals = await this.queries.usageTotals()
    const rows = await this.queries.usageByAllRoots(limit)
    const topRoots: VersionsRootUsage[] = []
    for (const row of rows) {
      const parsed = parseVersionsRoot(row.versionsRoot)
      topRoots.push({
        ...row,
        // A root the parser rejects is a row written by an older or broken code
        // path, not something to hide: an operator investigating storage needs to
        // see it. It gets no ceiling, because there is no user or space to size
        // one against, and no purge, because parseVersionsRoot gates that too.
        kind: parsed?.kind ?? 'user',
        name: parsed?.name ?? row.versionsRoot,
        ceiling: parsed ? await this.retention.rootCeiling(row.versionsRoot) : null
      })
    }
    return { ...totals, topRoots }
  }

  // Repoints every version row of one root at another (#471).
  //
  // WHY AN OPERATOR ENDPOINT EXISTS AT ALL. Both rename paths now repoint
  // their rows, so this is not needed for a rename performed by this code. It
  // is needed for every install that renamed a login or a space alias BEFORE
  // that shipped: their rows still name a root whose store has gone, so every
  // download and restore under it 404s, and the nightly sweep's error log
  // tells them so every night. Without this they would have exactly two
  // options — an UPDATE against the production database by hand, or living
  // with unreadable history — and the first is precisely the kind of surgery
  // this admin surface exists to make unnecessary.
  //
  // IT REPOINTS AND NOTHING ELSE. No blob is touched, no row is deleted, and
  // no file is moved: the only effect is which store the rows say their bytes
  // live in. That makes a mistaken call recoverable by calling it again the
  // other way round, which is the property worth having on a repair an
  // operator runs from a log line at 3AM.
  //
  // Both ends are validated against parseVersionsRoot — the same parser that
  // turns a root into a filesystem path — and the KIND must match. A user's
  // blobs live under `usersPath/<login>/versions` and a space's under
  // `spacesPath/<alias>/versions`; repointing across that line would produce
  // rows that resolve to a path their bytes were never in, i.e. the exact
  // breakage this repairs. A no-op (same root both ends) is refused rather
  // than answered 0, because it can only be a mistake and a silent 0 reads
  // like "there was nothing to fix".
  async repointRoot(fromVersionsRoot: string, toVersionsRoot: string): Promise<VersionsRepointResult> {
    const from = this.requireRoot(fromVersionsRoot)
    const to = this.requireRoot(toVersionsRoot)
    if (from.kind !== to.kind) {
      throw new FileError(HttpStatus.BAD_REQUEST, `cannot repoint a ${from.kind} root at a ${to.kind} root: their stores are in different trees`)
    }
    if (fromVersionsRoot === toVersionsRoot) {
      throw new FileError(HttpStatus.BAD_REQUEST, 'the source and target versions roots are the same')
    }
    const moved = await this.queries.renameRoot(fromVersionsRoot, toVersionsRoot)
    this.logger.log({ tag: this.repointRoot.name, msg: `repointed ${moved} version(s) from ${fromVersionsRoot} to ${toVersionsRoot}` })
    return { fromVersionsRoot, toVersionsRoot, moved }
  }

  // Purges one root's unnamed history. See VersionsRetention.purgeRoot for why
  // it goes through the retention path and why named versions survive.
  //
  // A root with no history is a zero result, not a 404: the action is idempotent
  // by nature, and answering 404 for "there is nothing to purge" would make a
  // second click look like a failure.
  async purgeRoot(versionsRoot: string): Promise<VersionsPurgeResult> {
    // Validated against the SAME parser that turns a root into a filesystem
    // path. The purge itself only ever uses the string as a DB equality filter
    // — blob paths are built from each ROW's recorded root — so this is defence
    // in depth rather than the only barrier, which is the right amount for a
    // destructive endpoint that takes a free-text identifier.
    this.requireRoot(versionsRoot)
    const { removed, removedBytes, keptLabeled } = await this.retention.purgeRoot(versionsRoot)
    return { versionsRoot, removed, removedBytes, keptLabeled }
  }

  // One rejection for every operator endpoint that takes a root, so the two
  // cannot drift into disagreeing about what a valid root is.
  private requireRoot(versionsRoot: string): { kind: VersionsRootKind; name: string } {
    const parsed = parseVersionsRoot(versionsRoot)
    if (!parsed) {
      throw new FileError(HttpStatus.BAD_REQUEST, `'${versionsRoot}' is not a versions root ('user:<login>' or 'space:<alias>')`)
    }
    return parsed
  }
}
