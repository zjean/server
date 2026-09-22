export interface DeleteFileOptions {
  protectedTrashPath?: string
  /* Fork: mod(files) — set by a caller that is about to write new content at
     this exact path (copyMove's overwrite helper). Suppresses the move-to-trash
     FileEvent: from a path-addressed consumer's point of view nothing was
     removed, the resource was replaced. See FilesManager.delete. */
  pathWillBeRecreated?: boolean
}
