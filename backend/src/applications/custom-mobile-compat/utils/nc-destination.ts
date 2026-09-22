import { normalizeNcSubpath } from '../services/nc-path-resolver.service'

/**
 * Strip `scheme://authority` (and any query/fragment) off a Destination header
 * value, leaving the path EXACTLY as the client wrote it.
 *
 * `new URL(dest).pathname` cannot be used for this. WHATWG URL parsing runs
 * RFC 3986 §5.2.4 remove_dot_segments over the path, and it treats `%2e` as a
 * dot while doing so — measured:
 *
 *   https://h/remote.php/dav/files/bob/a/../b     => /remote.php/dav/files/bob/b
 *   https://h/remote.php/dav/files/bob/a/./b      => /remote.php/dav/files/bob/a/b
 *   https://h/remote.php/dav/files/bob/a/%2e%2e/b => /remote.php/dav/files/bob/b
 *
 * so by the time a caller looks at `pathname`, the dot segments it meant to
 * refuse are already gone.
 */
export function rawDestinationPath(dest: string): string {
  // Two normalisations WHATWG applies that the raw string does not, and that a
  // dot-segment check must see or it looks past them — measured, both resolve:
  //
  //   https://h/remote.php/dav/files/bob/a/..\\b      => /remote.php/dav/files/bob/b
  //   https://h/remote.php/dav/files/bob/a/.<TAB>./b  => /remote.php/dav/files/bob/b
  //
  // ASCII tab/LF/CR are stripped anywhere in the input, and `\\` is a path
  // separator for a special scheme. Applying both here keeps the pre-check
  // looking at the same path `new URL()` will act on. Percent-encoding is NOT
  // touched — `%2e` is normalizeNcSubpath's job, and decoding here would make a
  // double-encoded `%252e` look like a dot segment when it names a real file.
  const deTabbed = dest.replace(/[\t\n\r]/g, '').replace(/\\/g, '/')
  const withoutOrigin = deTabbed.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*/, '')
  return withoutOrigin.split('#')[0].split('?')[0]
}

/**
 * Does a Destination header carry a `.` or `..` segment?
 *
 * The #483 decision is REJECT, not resolve — but that was only ever honoured
 * for path-relative destinations, because `new URL()` THROWS on those and the
 * raw string then survived to normalizeNcSubpath(). An absolute destination
 * was silently resolved instead, so the byte-identical request got a 400 in
 * one form and a sabre-style resolution in the other. Calling this BEFORE
 * `new URL()` makes both forms reject.
 *
 * Deliberately delegates to normalizeNcSubpath so the two checks cannot drift:
 * it decodes ONCE and then splits, which catches `%2e`, `%2E` and
 * `a%2F..%2Fb`, and correctly does NOT catch a double-encoded `%252e%252e`
 * (that names a file literally called `%2e%2e`).
 */
export function destinationHasDotSegments(dest: string): boolean {
  return normalizeNcSubpath(rawDestinationPath(dest)) === null
}
