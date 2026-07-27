import { getTableName } from 'drizzle-orm'
import { getTablesWithFileIdColumn } from '../../../infrastructure/database/utils'
import { customFilesVersions } from './files-versions.schema'

describe('custom_files_versions schema', () => {
  it('is named custom_files_versions so it cannot collide with an upstream files_versions', () => {
    // Upstream left `// todo : versioning here` markers, so them shipping a
    // `files_versions` table is a live possibility. Same reasoning as
    // custom_files_favorites.
    expect(getTableName(customFilesVersions)).toBe('custom_files_versions')
  })

  // THIS TEST GUARDS VERSION HISTORY AGAINST A NIGHTLY CRON.
  //
  // FilesScheduler.deleteOrphanFiles (@Cron EVERY_DAY_AT_4AM,
  // files-scheduler.service.ts:154) deletes every `files` row not referenced by
  // any table carrying a `fileId` column, discovering those tables by
  // reflecting over infrastructure/database/schema.ts via
  // getTablesWithFileIdColumn().
  //
  // Versioning materializes `files` rows on demand (custom-shared's
  // FileRowEnsurer) for files that have no other reference — an uploaded,
  // never-shared, never-commented file. Such a row's ONLY reference is its
  // version rows. If custom_files_versions were missing from that union — by
  // dropping the schema.ts export, or by renaming the column away from
  // `fileId` — the sweep would delete those `files` rows at 4 AM and the
  // ON DELETE CASCADE would silently take every version with them.
  //
  // Both halves of that contract are asserted here because both are one
  // careless edit away, and the failure is a nightly silent data loss that no
  // other test would catch.
  it('participates in the orphan-files sweep, so ensured rows are not deleted nightly', () => {
    expect(customFilesVersions.fileId).toBeDefined()
    const guarded = getTablesWithFileIdColumn().map((t) => getTableName(t))
    expect(guarded).toContain('custom_files_versions')
  })
})
