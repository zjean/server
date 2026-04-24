import { SPACE_ALL_OPERATIONS } from '../../spaces/constants/spaces'
import { toNcPermissions } from './nc-permissions'

describe('toNcPermissions', () => {
  it('emits nothing for a trashbin entry regardless of input permissions', () => {
    const r = toNcPermissions(SPACE_ALL_OPERATIONS, false, 'trashbin')
    expect(r.letters).toBe('')
    expect(r.shareMask).toBe('0')
  })

  it('emits full file permissions for a personal-space file', () => {
    const r = toNcPermissions(SPACE_ALL_OPERATIONS, false)
    expect(r.letters).toContain('G')
    expect(r.letters).toContain('W')
    expect(r.letters).toContain('D')
    expect(r.letters).toContain('N')
    expect(r.letters).toContain('V')
    expect(r.letters).toContain('R')
    expect(r.letters).not.toContain('C')
    expect(r.letters).not.toContain('K')
    // R(1)+U(2)+C(4)+D(8)+S(16) = 31
    expect(r.shareMask).toBe('31')
  })

  it('emits folder-specific C+K and suppresses W', () => {
    const r = toNcPermissions(SPACE_ALL_OPERATIONS, true)
    expect(r.letters).toContain('C')
    expect(r.letters).toContain('K')
    expect(r.letters).not.toContain('W')
  })

  it('emits just G for a read-only file', () => {
    const r = toNcPermissions('', false)
    expect(r.letters).toBe('G')
    expect(r.shareMask).toBe('1')
  })

  it('honors partial permissions (add-only, no delete)', () => {
    const r = toNcPermissions('a', false)
    expect(r.letters).toContain('G')
    expect(r.letters).toContain('W')
    expect(r.letters).not.toContain('D')
    expect(r.shareMask).toBe('5') // 1 | 4
  })

  it('treats null/undefined input as read-only', () => {
    expect(toNcPermissions(null, false).letters).toBe('G')
    expect(toNcPermissions(undefined, true).letters).toBe('G')
  })
})
