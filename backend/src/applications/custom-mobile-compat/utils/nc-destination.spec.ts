import { describe, expect, it } from 'vitest'
import { destinationHasDotSegments, rawDestinationPath } from './nc-destination'

// The #483 decision is "refuse a dot-segment Destination", but it was only
// honoured for path-relative destinations: `new URL()` throws on those, so the
// raw string survived to normalizeNcSubpath(), which rejects them. An absolute
// Destination went through `new URL(dest).pathname`, which applies RFC 3986
// remove_dot_segments — so the byte-identical request was refused in one form
// and silently resolved in the other.
describe('rawDestinationPath', () => {
  it('leaves dot segments in place where new URL().pathname would erase them', () => {
    const abs = 'https://cloud.example.org/remote.php/dav/files/bob/a/../b'
    expect(new URL(abs).pathname).toBe('/remote.php/dav/files/bob/b')
    expect(rawDestinationPath(abs)).toBe('/remote.php/dav/files/bob/a/../b')
  })

  it('leaves percent-encoded dot segments encoded', () => {
    expect(rawDestinationPath('https://h/remote.php/dav/files/bob/a/%2e%2e/b')).toBe('/remote.php/dav/files/bob/a/%2e%2e/b')
  })

  it('passes a path-relative destination through untouched', () => {
    expect(rawDestinationPath('/remote.php/dav/files/bob/a/b.txt')).toBe('/remote.php/dav/files/bob/a/b.txt')
  })

  it('drops the query string and fragment', () => {
    expect(rawDestinationPath('https://h/remote.php/dav/files/bob/a.txt?x=1#frag')).toBe('/remote.php/dav/files/bob/a.txt')
  })

  it('handles a non-default port and userinfo in the authority', () => {
    expect(rawDestinationPath('https://user:pw@cloud.example.org:8443/remote.php/dav/files/bob/a/../b')).toBe('/remote.php/dav/files/bob/a/../b')
  })
})

describe('destinationHasDotSegments', () => {
  it.each([
    ['/remote.php/dav/files/bob/a/../b', 'relative, plain'],
    ['/remote.php/dav/files/bob/a/./b', 'relative, single dot'],
    ['https://h/remote.php/dav/files/bob/a/../b', 'absolute, plain'],
    ['https://h/remote.php/dav/files/bob/a/./b', 'absolute, single dot'],
    ['https://h/remote.php/dav/files/bob/a/%2e%2e/b', 'absolute, lowercase percent-encoded'],
    ['https://h/remote.php/dav/files/bob/a/%2E%2E/b', 'absolute, uppercase percent-encoded'],
    ['https://h/remote.php/dav/files/bob/a%2F..%2Fb', 'absolute, encoded separators'],
    ['https://h/remote.php/dav/files/bob/..', 'absolute, trailing dot segment']
  ])('rejects %s (%s)', (dest) => {
    expect(destinationHasDotSegments(dest)).toBe(true)
  })

  it.each([
    ['/remote.php/dav/files/bob/Archive/report.pdf', 'ordinary relative'],
    ['https://h/remote.php/dav/files/bob/Archive/report.pdf', 'ordinary absolute'],
    ['https://h/remote.php/dav/files/bob/My%20folder/a.txt', 'escaped space'],
    ['https://h/remote.php/dav/files/bob/..hidden/a.txt', 'leading dots in a real name'],
    ['https://h/remote.php/dav/files/bob/a...b/c.txt', 'dots inside a real name']
  ])('accepts %s (%s)', (dest) => {
    expect(destinationHasDotSegments(dest)).toBe(false)
  })

  // One decode, same as normalizeNcSubpath. A doubly-encoded `%252e%252e`
  // names a file LITERALLY called `%2e%2e` — refusing it would be wrong.
  it('does not reject a double-encoded segment (a file named "%2e%2e")', () => {
    expect(destinationHasDotSegments('https://h/remote.php/dav/files/bob/%252e%252e/a.txt')).toBe(false)
  })

  // The two spellings WHATWG resolves but a byte-for-byte path does not show.
  // Without the tab/backslash normalisation in rawDestinationPath these reach
  // `new URL()`, which resolves the segment — the exact "reject vs resolve"
  // inconsistency this module exists to remove, just spelled differently.
  it.each([
    ['a backslash separator', 'https://h/remote.php/dav/files/bob/a/..\\b'],
    ['a backslash dot segment at the end', 'https://h/remote.php/dav/files/bob/a/..\\'],
    ['a tab inside the dot segment', 'https://h/remote.php/dav/files/bob/a/.\t./b'],
    ['a newline inside the dot segment', 'https://h/remote.php/dav/files/bob/a/.\n./b']
  ])('refuses %s', (_label, dest) => {
    expect(destinationHasDotSegments(dest)).toBe(true)
  })

  // ...while a filename that merely CONTAINS a dot or a backslash is untouched.
  it('allows a filename with dots that are not segments', () => {
    expect(destinationHasDotSegments('https://h/remote.php/dav/files/bob/my..file..txt')).toBe(false)
  })
})
