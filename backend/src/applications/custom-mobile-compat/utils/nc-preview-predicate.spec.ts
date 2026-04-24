import { ncHasPreview } from './nc-preview-predicate'

describe('ncHasPreview', () => {
  it('returns true for image/* mimes', () => {
    expect(ncHasPreview('image/jpeg')).toBe(true)
    expect(ncHasPreview('image/png')).toBe(true)
    expect(ncHasPreview('image/heic')).toBe(true)
  })

  it('returns true for pdf', () => {
    expect(ncHasPreview('application/pdf')).toBe(true)
  })

  it('normalizes Sync-in dash-format mime', () => {
    expect(ncHasPreview('image-jpeg')).toBe(true)
  })

  it('returns false for non-previewable mimes', () => {
    expect(ncHasPreview('text/plain')).toBe(false)
    expect(ncHasPreview('video/mp4')).toBe(false)
    expect(ncHasPreview('audio/mpeg')).toBe(false)
    expect(ncHasPreview('application/zip')).toBe(false)
  })

  it('returns false for empty/missing mime', () => {
    expect(ncHasPreview(null)).toBe(false)
    expect(ncHasPreview(undefined)).toBe(false)
    expect(ncHasPreview('')).toBe(false)
  })
})
