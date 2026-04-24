import { ncHasPreview } from './nc-preview-predicate'

describe('ncHasPreview', () => {
  it('returns true for image/* mimes', () => {
    expect(ncHasPreview('image/jpeg')).toBe(true)
    expect(ncHasPreview('image/png')).toBe(true)
    expect(ncHasPreview('image/heic')).toBe(true)
  })

  it('normalizes Sync-in dash-format mime', () => {
    expect(ncHasPreview('image-jpeg')).toBe(true)
  })

  it('returns false for non-previewable mimes (server cannot thumbnail them)', () => {
    expect(ncHasPreview('text/plain')).toBe(false)
    expect(ncHasPreview('video/mp4')).toBe(false)
    expect(ncHasPreview('audio/mpeg')).toBe(false)
    expect(ncHasPreview('application/zip')).toBe(false)
    // PDF intentionally excluded — Sync-in's thumbnail pipeline is image-only,
    // so advertising a PDF preview would 404 at request time.
    expect(ncHasPreview('application/pdf')).toBe(false)
  })

  it('returns false for empty/missing mime', () => {
    expect(ncHasPreview(null)).toBe(false)
    expect(ncHasPreview(undefined)).toBe(false)
    expect(ncHasPreview('')).toBe(false)
  })
})
