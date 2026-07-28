import type { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'

// Nextcloud's list and precedence order, from nextcloud/text
// lib/Service/WorkspaceService.php (SUPPORTED_STATIC_FILENAMES), minus two
// entries — see the design doc §2:
//   - '.Readme.md' is omitted: spaces-browser.service.ts:137 strips dotfiles
//     unless files.showHiddenFiles is on, and it defaults to false, so a hidden
//     readme is never in the browse response to be found.
//   - the l10n-translated 'Readme.md' variant is omitted: nobody names the file
//     'Leesmij.md'.
// Comparison is exact-case, matching upstream.
export const FOLDER_README_NAMES: readonly string[] = ['Readme.md', 'README.md', 'readme.md']

// Returns the folder's readme, or null. Directories are excluded: a directory
// named README.md is legal, and upstream guards the same case
// (getMimeType() !== ICacheEntry::DIRECTORY_MIMETYPE).
export function pickFolderReadme(files: readonly FileProps[]): FileProps | null {
  for (const name of FOLDER_README_NAMES) {
    const hit = files.find((f) => f.name === name && !f.isDir)
    if (hit) return hit
  }
  return null
}
