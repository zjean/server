import { API_FILES_OPERATION, API_FILES_TASK_OPERATION } from '@sync-in-server/backend/src/applications/files/constants/routes'
import type { FileLockProps, FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { encodeUrl } from '@sync-in-server/backend/src/common/shared'
import type { FileModel } from '../../../files/models/file.model'

// Returns a FileModel-shaped object covering the fields + methods used by
// FilesService, FilesUploadService, and the OnlyOffice viewer:
//   path, name, isDir, mime, size, mtime, id
//   isBeingDeleted (mutable)
//   lock (mutable)
//   encodedPath, dataUrl, taskUrl (getters)
//   updateHTimeAgo, createLock, removeLock (methods)
//
// Note: this stub omits badges / shares / spaces / links / syncs arrays and
// the heavier computed fields (mimeUrl, hSize, galleryBadges, etc.) because
// the v2 surfaces don't need them. If a classic codepath reads one of those,
// extend the stub rather than constructing a real FileModel — its constructor
// requires EditorProviders + a parent basePath, which the v2 screens don't
// carry around.
export function buildFileModelStub(props: FileProps, fullPath: string): FileModel {
  const encoded = encodeUrl(fullPath)
  const stub: Record<string, unknown> = {
    id: props.id,
    path: fullPath,
    name: props.name,
    isDir: props.isDir,
    mime: props.mime,
    size: props.size,
    mtime: props.mtime,
    ctime: props.ctime,
    hasComments: (props as FileProps & { hasComments?: boolean }).hasComments ?? false,
    isBeingDeleted: false,
    lock: null as FileLockProps | null,
    encodedPath: encoded,
    dataUrl: `${API_FILES_OPERATION}/${encoded}`,
    taskUrl: `${API_FILES_TASK_OPERATION}/${encoded}`,
    updateHTimeAgo(this: Record<string, unknown>, _mtime?: number) {
      // No-op in v2 — the UI doesn't render hTimeAgo off this stub.
      // Kept so classic callers (FilesViewerOnlyOfficeComponent.onSave) don't throw.
    },
    createLock(this: Record<string, unknown>, lock: FileLockProps) {
      this.lock = lock
    },
    removeLock(this: Record<string, unknown>) {
      this.lock = null
    }
  }
  return stub as unknown as FileModel
}

// Build the full server path for a file inside a space repository.
export function buildSpaceFilePath(repository: string, alias: string, segments: readonly string[], name: string): string {
  return [repository, alias, ...segments, name].join('/')
}
