// Pins the thumbnail URL composition (#428).
//
// The component built this URL from the raw `file().path` for its whole life,
// and `path` on a browse-API row is the PARENT directory — so every cell in a
// folder requested the same directory, got a 403, and rendered a glyph. The
// address now arrives as an input; this file pins the shape the backend wants,
// against classic's own composition (files/models/file.model.ts:113 plus the
// `?size=` its two call sites append).
//
// No TestBed and no template here — same reason as icon-button.component.spec.ts:
// nothing in this suite compiles a template. The URL builder is a pure function
// so it can be pinned directly; the two bindings that feed it are pinned on the
// browser side (file-browser-contract.ts, "thumbnails") and browser-verified in
// the PR.

import { describe, expect, it } from 'vitest'
import { fileThumbnailUrl } from './file-thumb.component'

const THUMBNAIL = '/api/app/spaces/operation/thumbnail'

describe('fileThumbnailUrl', () => {
  it('addresses the file itself, repository-qualified, with the size query', () => {
    expect(fileThumbnailUrl('files/personal/Photos/office-window.jpg', 512)).toBe(`${THUMBNAIL}/files/personal/Photos/office-window.jpg?size=512`)
  })

  it('carries the size through unchanged — the backend clamps, not us', () => {
    expect(fileThumbnailUrl('files/personal/a.png', 256)).toBe(`${THUMBNAIL}/files/personal/a.png?size=256`)
  })

  it('works for any repository prefix, not just personal', () => {
    expect(fileThumbnailUrl('files/marketing/logo.png', 256)).toBe(`${THUMBNAIL}/files/marketing/logo.png?size=256`)
    expect(fileThumbnailUrl('shares/press-kit/cover.jpg', 256)).toBe(`${THUMBNAIL}/shares/press-kit/cover.jpg?size=256`)
  })

  it('percent-encodes each segment but keeps the separators — classic encodeUrl', () => {
    // A literal '/' would be encoded away by encodeURIComponent on the whole
    // string, which is why classic splits on it first. Spaces, '#' and '?' in a
    // filename must all survive as escapes or the route resolves elsewhere.
    expect(fileThumbnailUrl('files/personal/My Photos/a b#1?.jpg', 256)).toBe(`${THUMBNAIL}/files/personal/My%20Photos/a%20b%231%3F.jpg?size=256`)
  })
})
