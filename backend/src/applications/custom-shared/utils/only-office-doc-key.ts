import { ONLY_OFFICE_CACHE_KEY } from '../../files/editors/only-office/only-office.constants'
import type { FileDBProps } from '../../files/interfaces/file-db-props.interface'
import { genUniqHashFromFileDBProps } from '../../files/utils/files'

// The cache key under which OnlyOfficeManager parks a file's OnlyOffice
// *document key* (only-office-manager.service.ts::getCacheKey).
//
// Why a fork-owned copy of a one-line expression instead of calling the manager:
// OnlyOfficeManager is provided by OnlyOfficeModule, which is imported only when
// an office editor is enabled, and the manager already depends on
// VersioningService — so a versioning → manager call would be both conditional
// and a provider cycle. Reading the cache directly is the same escape hatch
// NcOnlyOfficeForceSaveService already takes, and this function exists so the
// expression has ONE home rather than three.
//
// The manager owns the format and its getCacheKey is private, so nothing can
// assert the two agree at runtime. `only-office-doc-key.spec.ts` pins this side
// — prefix, separator and hash source — so a drift in the manager's shape shows
// up as a failing expectation here rather than as an invalidation that silently
// deletes nothing. On every upstream sync, diff getCacheKey.
export function onlyOfficeDocKeyCacheKey(dbFile: FileDBProps): string {
  return `${ONLY_OFFICE_CACHE_KEY}|${genUniqHashFromFileDBProps(dbFile)}`
}
