import { describe, expect, it } from 'vitest'
import { ONLY_OFFICE_CACHE_KEY } from '../../files/editors/only-office/only-office.constants'
import type { FileDBProps } from '../../files/interfaces/file-db-props.interface'
import { genUniqHashFromFileDBProps } from '../../files/utils/files'
import { onlyOfficeDocKeyCacheKey } from './only-office-doc-key'

// FileDBProps shape per file-db-props.interface.ts — only the fields
// genUniqHashFromFileDBProps consumes matter for keying.
const dbFile = (over: Partial<FileDBProps> = {}): FileDBProps =>
  ({ id: 1, ownerId: 7, spaceId: 0, spaceExternalRootId: 0, isDir: false, inTrash: false, path: 'docs/a.docx', ...over }) as FileDBProps

describe('onlyOfficeDocKeyCacheKey', () => {
  // The three parts of the format OnlyOfficeManager.getCacheKey builds. Asserted
  // separately from the whole string so a failure says WHICH part drifted.
  it('is the OnlyOffice cache prefix, a pipe, and the file hash', () => {
    const file = dbFile()
    expect(onlyOfficeDocKeyCacheKey(file)).toBe(`${ONLY_OFFICE_CACHE_KEY}|${genUniqHashFromFileDBProps(file)}`)
    expect(onlyOfficeDocKeyCacheKey(file).startsWith(`${ONLY_OFFICE_CACHE_KEY}|`)).toBe(true)
  })

  it('is stable for the same file', () => {
    expect(onlyOfficeDocKeyCacheKey(dbFile())).toBe(onlyOfficeDocKeyCacheKey(dbFile()))
  })

  // The point of the key: an invalidation aimed at one file must not name
  // another file's cache entry.
  it('differs between two files', () => {
    expect(onlyOfficeDocKeyCacheKey(dbFile({ id: 1 }))).not.toBe(onlyOfficeDocKeyCacheKey(dbFile({ id: 2 })))
  })
})
