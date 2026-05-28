import { parseOcTotalLength } from './nc-uploads.controller'

// OC-Total-Length is part of the NC chunked-upload protocol — clients are
// expected to send it on the assembly MOVE, but Android NextcloudKit may
// omit it on the chunked path (audit U1 hypothesis). We accept the header
// as optional but verify equality when present. The parse helper centralizes
// the "is the client telling us how much they uploaded?" decision so the
// controller's main path stays linear.
describe('parseOcTotalLength', () => {
  it('returns the integer value for a well-formed positive header', () => {
    expect(parseOcTotalLength('1024')).toBe(1024)
  })

  it('returns null for an absent header', () => {
    expect(parseOcTotalLength(undefined)).toBeNull()
  })

  it('returns null for the empty string', () => {
    expect(parseOcTotalLength('')).toBeNull()
  })

  it('returns null for a non-numeric header', () => {
    expect(parseOcTotalLength('not-a-number')).toBeNull()
  })

  it('returns null for zero (no zero-byte upload assembly)', () => {
    expect(parseOcTotalLength('0')).toBeNull()
  })

  it('returns null for a negative number', () => {
    expect(parseOcTotalLength('-1')).toBeNull()
  })

  // Fastify exposes repeated headers as a string[]; for our purposes we
  // honor the first value and ignore any duplicates. Real clients won't
  // send the header twice — this is defensive.
  it('parses the first element when an array is passed', () => {
    expect(parseOcTotalLength(['2048', 'ignored'])).toBe(2048)
  })
})
