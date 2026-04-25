import { buildOcId } from './nc-oc-id'

describe('buildOcId', () => {
  it('zero-pads fileid to 20 digits and appends the instance tag', () => {
    expect(buildOcId(42)).toBe('00000000000000000042syncin')
  })

  it('returns a stable 26-char string regardless of input size', () => {
    expect(buildOcId(0)).toHaveLength(26)
    expect(buildOcId(1)).toHaveLength(26)
    expect(buildOcId(Number.MAX_SAFE_INTEGER)).toHaveLength(26)
  })

  it('treats null and undefined as 0', () => {
    expect(buildOcId(null)).toBe(buildOcId(0))
    expect(buildOcId(undefined)).toBe(buildOcId(0))
  })

  it('uses absolute value for negative ids — Sync-in encodes filesystem-only files as negative inode numbers, but NC iOS requires a stable positive primary key per file', () => {
    // Different negative inodes must produce DIFFERENT oc:ids; previously the
    // clamp-to-zero made them all collide, hiding freshly-uploaded files in
    // iOS because oc:id is the offline-cache primary key.
    expect(buildOcId(-5)).toBe(buildOcId(5))
    expect(buildOcId(-12345)).toBe(buildOcId(12345))
    expect(buildOcId(-5)).not.toBe(buildOcId(-6))
  })

  it('is deterministic for the same input', () => {
    expect(buildOcId(123)).toBe(buildOcId(123))
  })
})
