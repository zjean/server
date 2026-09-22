import { FILE_OPERATION } from '@sync-in-server/backend/src/applications/files/constants/operations'
import { describe, expect, it } from 'vitest'
import { activeTaskLabel, NEUTRAL_TASK_LABEL } from './task-labels'

describe('activeTaskLabel', () => {
  it('names the operation when every task in the batch agrees', () => {
    expect(activeTaskLabel([FILE_OPERATION.DELETE])).toEqual({ headline: 'v2_deleting_n_of_m', glyph: 'trash' })
    expect(activeTaskLabel([FILE_OPERATION.UPLOAD, FILE_OPERATION.UPLOAD])).toEqual({ headline: 'v2_uploading_n_of_m', glyph: 'upload' })
  })

  it('falls back to the neutral verb for a mixed batch', () => {
    // "Uploading 2 of 3" while one of the three is a delete is worse than saying less.
    expect(activeTaskLabel([FILE_OPERATION.UPLOAD, FILE_OPERATION.DELETE])).toBe(NEUTRAL_TASK_LABEL)
  })

  it('falls back for an operation that has no label yet', () => {
    // A new operation growing a task must not read as an upload — which is the defect
    // this module exists for, seen from the future.
    expect(activeTaskLabel([FILE_OPERATION.LOCK])).toBe(NEUTRAL_TASK_LABEL)
  })

  it('falls back for an empty batch', () => {
    expect(activeTaskLabel([])).toBe(NEUTRAL_TASK_LABEL)
  })

  it('covers every operation that registers a task', () => {
    // The seven in `FilesTasksService.onDone`. If upstream adds an eighth, this fails
    // and the neutral fallback is the deliberate choice rather than an oversight.
    const tracked = [
      FILE_OPERATION.DELETE,
      FILE_OPERATION.MOVE,
      FILE_OPERATION.COPY,
      FILE_OPERATION.DOWNLOAD,
      FILE_OPERATION.UPLOAD,
      FILE_OPERATION.COMPRESS,
      FILE_OPERATION.DECOMPRESS
    ]
    for (const op of tracked) {
      expect(activeTaskLabel([op]), op).not.toBe(NEUTRAL_TASK_LABEL)
    }
  })
})
