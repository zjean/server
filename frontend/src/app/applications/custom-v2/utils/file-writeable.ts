import type { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { SPACE_OPERATION } from '@sync-in-server/backend/src/applications/spaces/constants/spaces'
import { intersectPermissions } from '@sync-in-server/backend/src/common/shared'

// The ONE expression in v2 of "may this user write this file".
//
// It is a transcription of classic's contract, which classic states across two
// files — and that split is the reason to have this one:
//
//   - `SpacesBrowserComponent.openViewerDialog` (spaces-browser.component.ts)
//     resolves the EFFECTIVE permissions, intersecting the space's permission
//     string with the row's own root permissions.
//   - `FilesService.openViewerAfterAvailabilityCheck` (files.service.ts) then
//     tests MODIFY against that and rejects an exclusive lock.
//
// Both halves live here because a caller that has a browse response has both
// pieces, and every v2 site that hand-copied one half copied it slightly
// differently (issue #372).
//
// Deliberately NOT applied to classic's own two sites: `files.service.ts` and
// `spaces-browser.component.ts` are pure upstream files, and importing a
// `custom-*` util into them would put them on the merge-conflict surface of
// every upstream sync for no behavioural gain. Classic keeps its expression;
// this is v2's, and this comment is the link between them.
//
// The root intersection is conditional because the browse response only
// pre-intersects when the browsed URL is itself inside a root (backend
// `SpaceEnv.browsePermissions` via `getEnvPermissions`). At a space's top level
// the narrower per-root grant arrives on the row instead — `root` is set only by
// `spaces-browser.service.ts::updateRootFile` — and has to be applied here.
//
// Repository-level narrowing is the CALLER's job, exactly as it is in classic:
// `openViewerDialog` passes `''` for trash before ever reaching the MODIFY test.
// Pass `''` and this returns false.
//
// A lock of the caller's OWN is not special-cased here. It cannot be: nothing in
// `FileLockProps` distinguishes this session's lock from another lock of the same
// user by the same app, so the only honest test is on state the caller holds. The
// folder readme banner does that in `readme()` — it strips a lock it knows it took
// and hands the stripped row here. See that component for why the path, not the
// lock's contents, is what makes the drop safe.
export function isFileWriteable(file: FileProps | null | undefined, permissions: string): boolean {
  if (!file) return false
  const effective = file.root?.permissions ? intersectPermissions(permissions, file.root.permissions) : permissions
  return effective.includes(SPACE_OPERATION.MODIFY) && !file.lock?.isExclusive
}
