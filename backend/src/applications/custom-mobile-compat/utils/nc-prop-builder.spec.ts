import { describe, expect, it } from 'vitest'
import { SPACE_ALIAS, SPACE_ALL_OPERATIONS, SPACE_REPOSITORY } from '../../spaces/constants/spaces'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { WebDAVFile } from '../../webdav/models/webdav-file.model'
import { buildNcPropResponse } from './nc-prop-builder'

function file(): WebDAVFile {
  return new WebDAVFile(
    { id: 100, name: 'pic.jpg', isDir: false, size: 1234, ctime: Date.now(), mtime: Date.now(), mime: 'image/jpeg' },
    '/remote.php/dav/files/alice/'
  )
}

const space = {
  id: 0,
  alias: SPACE_ALIAS.PERSONAL,
  envPermissions: SPACE_ALL_OPERATIONS,
  permissions: SPACE_ALL_OPERATIONS,
  repository: SPACE_REPOSITORY.FILES,
  root: { id: 0, alias: 'personal', name: 'personal', permissions: SPACE_ALL_OPERATIONS, owner: { id: 1, login: 'alice' } }
} as unknown as SpaceEnv

function favProp(isFavorite: boolean): unknown {
  const r = buildNcPropResponse(file(), space, 'files', false, 'Alice', undefined, undefined, isFavorite) as Record<string, any>
  return r['d:propstat']['d:prop']['oc:favorite']
}

describe('buildNcPropResponse oc:favorite', () => {
  it('emits the integer string "1" when favorited (NOT the word "true" — Android compares to literal "1")', () => {
    expect(favProp(true)).toBe('1')
  })

  it('emits the integer string "0" when not favorited', () => {
    expect(favProp(false)).toBe('0')
  })

  it('defaults to "0" when the isFavorite argument is omitted', () => {
    const r = buildNcPropResponse(file(), space, 'files', false, 'Alice') as Record<string, any>
    expect(r['d:propstat']['d:prop']['oc:favorite']).toBe('0')
  })
})
