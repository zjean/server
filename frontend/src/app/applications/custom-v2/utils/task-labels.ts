import { FILE_OPERATION } from '@sync-in-server/backend/src/applications/files/constants/operations'
import type { IconV2Name } from '../icons/icon-v2.component'

/** What the dock's header line says and shows while work is in flight. */
export interface ActiveTaskLabel {
  /** i18n key taking `{ n, m }`. */
  headline: string
  glyph: IconV2Name
}

/**
 * The dock is named for uploads and used by everything.
 *
 * `TransfersService` publishes every task in `store.filesActiveTasks`, and seven
 * operations register there (`FilesTasksService.onDone` enumerates them). The header
 * nonetheless said "Uploading n of m" for all of them, so emptying the trash announced
 * an upload. The verb comes from the tasks themselves instead.
 *
 * A batch is only described by a specific verb when every task in it agrees; a mixed
 * batch gets the neutral one, because "Uploading 2 of 3" is worse than saying less when
 * one of the three is a delete.
 */
const BY_OPERATION: Partial<Record<FILE_OPERATION, ActiveTaskLabel>> = {
  [FILE_OPERATION.UPLOAD]: { headline: 'v2_uploading_n_of_m', glyph: 'upload' },
  [FILE_OPERATION.DOWNLOAD]: { headline: 'v2_downloading_n_of_m', glyph: 'download' },
  [FILE_OPERATION.DELETE]: { headline: 'v2_deleting_n_of_m', glyph: 'trash' },
  [FILE_OPERATION.COPY]: { headline: 'v2_copying_n_of_m', glyph: 'copy' },
  [FILE_OPERATION.MOVE]: { headline: 'v2_moving_n_of_m', glyph: 'moveTo' },
  [FILE_OPERATION.COMPRESS]: { headline: 'v2_compressing_n_of_m', glyph: 'archive' },
  [FILE_OPERATION.DECOMPRESS]: { headline: 'v2_decompressing_n_of_m', glyph: 'archive' }
}

/** Mixed batches, and any operation that grows a task later without landing in the map. */
export const NEUTRAL_TASK_LABEL: ActiveTaskLabel = { headline: 'v2_working_n_of_m', glyph: 'activity' }

export function activeTaskLabel(types: readonly FILE_OPERATION[]): ActiveTaskLabel {
  if (types.length === 0) return NEUTRAL_TASK_LABEL
  const first = types[0]
  if (!types.every((t) => t === first)) return NEUTRAL_TASK_LABEL
  return BY_OPERATION[first] ?? NEUTRAL_TASK_LABEL
}
