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

  it('treats null, undefined, and negative as 0', () => {
    expect(buildOcId(null)).toBe(buildOcId(0))
    expect(buildOcId(undefined)).toBe(buildOcId(0))
    expect(buildOcId(-5)).toBe(buildOcId(0))
  })

  it('is deterministic for the same input', () => {
    expect(buildOcId(123)).toBe(buildOcId(123))
  })
})
