// Which files the diagram routes are allowed to touch.
//
// WHY THIS EXISTS. `/api/diagrams/load` and `/api/diagrams/save` gated on
// nothing but the caller's MODIFY permission, so they doubled as a generic
// read-any-file / replace-any-file primitive: a GET of
// `files/personal/report.docx` returned up to 10 MB of its bytes as JSON along
// with the sha1 etag, and a PUT with that etag replaced the document with
// arbitrary text. That is not privilege escalation — the user already had
// MODIFY — but it is an integrity hole, because this pair of routes is not the
// normal write path and the docx came back destroyed.
//
// Kept deliberately identical to the frontend's `DIAGRAM_EXTENSIONS`
// (`custom-v2/utils/classify-file.ts`), which decides when the diagram viewer
// is offered at all. If the two ever disagree, the UI offers an editor whose
// save the server refuses.
const DIAGRAM_EXTENSIONS: ReadonlySet<string> = new Set(['drawio', 'dwb'])

export function isDiagramExt(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return false
  return DIAGRAM_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}
