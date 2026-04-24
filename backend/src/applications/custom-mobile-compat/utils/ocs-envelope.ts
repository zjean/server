// OCS JSON envelope helper.
//
// Nextcloud OCS endpoints wrap responses in:
//   { "ocs": { "meta": { "status", "statuscode", "message", "totalitems", "itemsperpage" }, "data": <payload> } }
//
// Mobile clients accept JSON via Accept: application/json or ?format=json. XML
// is the legacy default; we intentionally only support JSON in this module.

export interface OcsMeta {
  status: 'ok' | 'failure'
  statuscode: number
  message: string
  totalitems?: string
  itemsperpage?: string
}

export interface OcsEnvelope<T> {
  ocs: {
    meta: OcsMeta
    data: T
  }
}

export interface OcsOptions {
  status?: 'ok' | 'failure'
  statuscode?: number
  message?: string
  totalitems?: number
  itemsperpage?: number
}

// OCS v1 uses HTTP 200 for errors and encodes the error in meta.statuscode.
// OCS v2 uses the matching HTTP status. We return only meta+data here; the
// caller is responsible for setting the right HTTP status on the reply.
export function ocsEnvelope<T>(data: T, opts: OcsOptions = {}): OcsEnvelope<T> {
  const meta: OcsMeta = {
    status: opts.status ?? 'ok',
    statuscode: opts.statuscode ?? 100,
    message: opts.message ?? ''
  }
  if (opts.totalitems !== undefined) meta.totalitems = String(opts.totalitems)
  if (opts.itemsperpage !== undefined) meta.itemsperpage = String(opts.itemsperpage)
  return { ocs: { meta, data } }
}

// True if the Accept header is compatible with OCS JSON responses.
// We accept application/json, */*, and empty. We reject explicit xml requests.
export function acceptsJson(accept: string | string[] | undefined): boolean {
  const header = Array.isArray(accept) ? accept.join(',') : (accept ?? '')
  if (!header.trim()) return true
  const lower = header.toLowerCase()
  // Explicit xml-only request → reject
  if (/application\/xml|text\/xml/.test(lower) && !/application\/json|\*\/\*/.test(lower)) return false
  return true
}
