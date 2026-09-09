-- Carry the fork's favorites into upstream's table before dropping ours.
--
-- Hand-added to a drizzle-GENERATED migration (the DROP below is the generated
-- part, and meta/_journal.json + meta/0010_snapshot.json are entirely tooling-
-- written). A schema diff cannot express a data copy, so there is no tooling-only
-- path to a non-destructive migration here. See
-- docs/plans/2026-09-07-favorites-upstream-adoption-plan.md §4.
--
-- Ordering is load-bearing: `files_favorites` is created in 0009 and
-- `custom_files_favorites` must survive until after this INSERT.
--
-- INSERT IGNORE because both tables are keyed (userId, fileId). NOT because of a
-- window between 0009 and this file — there is none: drizzle applies a pending batch
-- in one `migrate` call, and both ship in the same release, so files_favorites is
-- empty when the copy runs. It guards the cases that CAN happen: a re-run, or 0009
-- having been applied by hand. Both columns already carry the same FKs to users.id /
-- files.id, so every copied row satisfies upstream's constraints, and the fork's
-- table cascade-deleted its own orphans — so IGNORE cannot be masking a lost row.
-- The columns left behind (path, spaceId, shareId) are the fork's stored access
-- context, which upstream re-derives per request instead.
INSERT IGNORE INTO `files_favorites` (`userId`, `fileId`, `createdAt`)
	SELECT `userId`, `fileId`, `createdAt` FROM `custom_files_favorites`;
--> statement-breakpoint
DROP TABLE `custom_files_favorites`;
