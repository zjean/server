import type { FileRecent } from '../../files/schemas/file-recent.interface'
import { toRecommendationEntry } from './nc-recommendation-entry'

const homePrefix = 'files/personal'

function recent(overrides: Partial<FileRecent> = {}): FileRecent {
  return {
    id: 42,
    ownerId: 1,
    spaceId: 0,
    shareId: 0,
    path: 'files/personal/Documents',
    name: 'report.docx',
    mime: 'application-vnd.openxmlformats-officedocument.wordprocessingml.document',
    mtime: 1714742400000,
    ...overrides
  } as FileRecent
}

describe('toRecommendationEntry', () => {
  it('maps a recent under the home prefix to an NC entry (NK wire shape)', () => {
    // Field types are dictated by NextcloudKit's XML parser:
    //   - id is String (upstream serializes (string)$node->getId())
    //   - hasPreview is text "1"/"0" (NK does literal text == "1")
    //   - timestamp is Unix seconds (NK converts Double>0 to Date)
    expect(toRecommendationEntry(recent(), homePrefix)).toEqual({
      id: '42',
      timestamp: 1714742400,
      name: 'report.docx',
      directory: '/Documents',
      extension: 'docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      hasPreview: '0',
      reason: 'recent'
    })
  })

  it('uses "/" as directory for files at the home root', () => {
    const r = recent({ path: 'files/personal', name: 'photo.jpg', mime: 'image-jpeg' })
    expect(toRecommendationEntry(r, homePrefix)).toMatchObject({ directory: '/', name: 'photo.jpg' })
  })

  it('keeps deep directories', () => {
    const r = recent({ path: 'files/personal/Projects/2026/Q1', name: 'plan.md' })
    expect(toRecommendationEntry(r, homePrefix)?.directory).toBe('/Projects/2026/Q1')
  })

  it('returns null when the recent is outside the home prefix', () => {
    // Different space — would 404 if iOS tapped it.
    expect(toRecommendationEntry(recent({ path: 'files/team-marketing/Brand' }), homePrefix)).toBeNull()
    // Prefix-confusable path — must require a "/" boundary, not a string prefix.
    expect(toRecommendationEntry(recent({ path: 'files/personal-archive/x' }), homePrefix)).toBeNull()
  })

  it('extracts extension as the last segment after the final dot', () => {
    expect(toRecommendationEntry(recent({ name: 'archive.tar.gz' }), homePrefix)?.extension).toBe('gz')
    expect(toRecommendationEntry(recent({ name: 'README' }), homePrefix)?.extension).toBe('')
    expect(toRecommendationEntry(recent({ name: '.bashrc' }), homePrefix)?.extension).toBe('')
  })

  it('translates Sync-in dash-form mime to standard slash form', () => {
    expect(toRecommendationEntry(recent({ mime: 'image-jpeg' }), homePrefix)?.mimeType).toBe('image/jpeg')
    expect(toRecommendationEntry(recent({ mime: 'application-zip' }), homePrefix)?.mimeType).toBe('application/zip')
  })

  it('passes through already-standard mimes unchanged', () => {
    expect(toRecommendationEntry(recent({ mime: 'image/png' }), homePrefix)?.mimeType).toBe('image/png')
  })

  it('falls back to application/octet-stream when mime is missing', () => {
    expect(toRecommendationEntry(recent({ mime: null as unknown as string }), homePrefix)?.mimeType).toBe('application/octet-stream')
    expect(toRecommendationEntry(recent({ mime: '' }), homePrefix)?.mimeType).toBe('application/octet-stream')
  })

  it('emits hasPreview as text "1"/"0" so NextcloudKit\'s text == "1" check works', () => {
    expect(toRecommendationEntry(recent({ mime: 'image-jpeg' }), homePrefix)?.hasPreview).toBe('1')
    expect(toRecommendationEntry(recent({ mime: 'image/png' }), homePrefix)?.hasPreview).toBe('1')
    expect(toRecommendationEntry(recent({ mime: 'application-pdf' }), homePrefix)?.hasPreview).toBe('0')
    expect(toRecommendationEntry(recent({ mime: 'video-mp4' }), homePrefix)?.hasPreview).toBe('0')
  })

  it('stringifies id (NK NKRecommendation.id is String, upstream serializes (string)$node->getId())', () => {
    expect(toRecommendationEntry(recent({ id: 999 }), homePrefix)?.id).toBe('999')
  })

  it('converts mtime from milliseconds to seconds', () => {
    expect(toRecommendationEntry(recent({ mtime: 1700000000123 }), homePrefix)?.timestamp).toBe(1700000000)
    expect(toRecommendationEntry(recent({ mtime: 0 }), homePrefix)?.timestamp).toBe(0)
  })
})
