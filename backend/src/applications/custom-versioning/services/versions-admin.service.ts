import { HttpStatus, Injectable } from '@nestjs/common'
import { FileError } from '../../files/models/file-error'
import { VERSIONS_ADMIN_TOP_ROOTS } from '../constants/versioning'
import { VersionsPurgeResult, VersionsRootUsage, VersionsStorageSummary } from '../interfaces/version.interface'
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
    if (!parseVersionsRoot(versionsRoot)) {
      throw new FileError(HttpStatus.BAD_REQUEST, `'${versionsRoot}' is not a versions root ('user:<login>' or 'space:<alias>')`)
    }
    const { removed, removedBytes, keptLabeled } = await this.retention.purgeRoot(versionsRoot)
    return { versionsRoot, removed, removedBytes, keptLabeled }
  }
}
