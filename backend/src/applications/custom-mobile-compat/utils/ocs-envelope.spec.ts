import { acceptsJson, ocsEnvelope } from './ocs-envelope'

describe('ocsEnvelope', () => {
  it('defaults to OCS-v2 success shape (statuscode=200) — matches real NC server', () => {
    // OCS v2 endpoints mirror the HTTP status in `meta.statuscode`. NC iOS
    // strict-checks this and surfaces a "Fout" alert on `100`. Default to 200
    // because v2 is the modern path; v1 endpoints opt in via `{ statuscode:
    // OCS_OK_V1 }`.
    const env = ocsEnvelope({ hello: 'world' })
    expect(env).toEqual({
      ocs: {
        meta: { status: 'ok', statuscode: 200, message: '' },
        data: { hello: 'world' }
      }
    })
  })

  it('v1 callers pass `statuscode: 100` explicitly for legacy compat', () => {
    const env = ocsEnvelope({ legacy: true }, { statuscode: 100 })
    expect(env.ocs.meta.statuscode).toBe(100)
  })

  it('accepts status/statuscode/message overrides', () => {
    const env = ocsEnvelope(null, { status: 'failure', statuscode: 997, message: 'nope' })
    expect(env.ocs.meta.status).toBe('failure')
    expect(env.ocs.meta.statuscode).toBe(997)
    expect(env.ocs.meta.message).toBe('nope')
    expect(env.ocs.data).toBeNull()
  })

  it('stringifies totalitems and itemsperpage', () => {
    const env = ocsEnvelope([], { totalitems: 42, itemsperpage: 50 })
    expect(env.ocs.meta.totalitems).toBe('42')
    expect(env.ocs.meta.itemsperpage).toBe('50')
    expect(typeof env.ocs.meta.totalitems).toBe('string')
    expect(typeof env.ocs.meta.itemsperpage).toBe('string')
  })

  it('omits totalitems/itemsperpage when not given', () => {
    const env = ocsEnvelope({})
    expect(env.ocs.meta.totalitems).toBeUndefined()
    expect(env.ocs.meta.itemsperpage).toBeUndefined()
  })

  it('preserves the data payload verbatim (primitive)', () => {
    expect(ocsEnvelope('hello').ocs.data).toBe('hello')
  })

  it('preserves the data payload verbatim (array)', () => {
    const arr = [1, 2, 3]
    expect(ocsEnvelope(arr).ocs.data).toBe(arr)
  })
})

describe('acceptsJson', () => {
  it('returns true for an empty/whitespace header', () => {
    expect(acceptsJson(undefined)).toBe(true)
    expect(acceptsJson('')).toBe(true)
    expect(acceptsJson('   ')).toBe(true)
  })

  it('returns true for */*', () => {
    expect(acceptsJson('*/*')).toBe(true)
  })

  it('returns true for application/json', () => {
    expect(acceptsJson('application/json')).toBe(true)
  })

  it('returns false for application/xml', () => {
    expect(acceptsJson('application/xml')).toBe(false)
  })

  it('returns false for text/xml', () => {
    expect(acceptsJson('text/xml')).toBe(false)
  })

  it('returns true when xml is mixed with json in a comma list', () => {
    expect(acceptsJson('application/xml, application/json')).toBe(true)
  })

  it('returns true when xml is mixed with */* in a comma list', () => {
    expect(acceptsJson('application/xml, */*')).toBe(true)
  })

  it('returns true for uppercased application/JSON', () => {
    expect(acceptsJson('application/JSON')).toBe(true)
  })

  it('handles array-form headers by joining with comma', () => {
    expect(acceptsJson(['application/xml', 'application/json'])).toBe(true)
    expect(acceptsJson(['application/xml'])).toBe(false)
  })
})
