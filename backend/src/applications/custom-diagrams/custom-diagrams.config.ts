import { IsNotEmpty, IsString, Matches } from 'class-validator'

// THE one definition of the drawio editor location.
//
// It used to be `process.env['DRAWIO_URL'] ?? 'https://embed.diagrams.net'`,
// written out twice — once here and once in `app.constants.ts`, which builds the
// CSP `frame-src`. Two copies that must agree, and if they ever disagreed the
// iframe would be blocked and the feature would die with a console-only CSP
// error. It was also the only backend setting read straight from `process.env`:
// absent from `environment.dist.yaml`, so no `SYNCIN_*` variable reached it,
// invisible to the config validator, and undiscoverable by an operator reading
// the config file (#499, the silent-failure class of #384).
//
// NOTE ON THE DEFAULT. `embed.diagrams.net` is a THIRD PARTY. The complete XML
// of every diagram a user opens is posted into a page served by JGraph, which
// can send it anywhere. That is a meaningful default for a self-hosted file
// server, so the value is documented in `environment.dist.yaml` with a warning
// and the v2 viewer tells the user when the editor is not same-origin.
export const DEFAULT_DIAGRAMS_EDITOR_URL = 'https://embed.diagrams.net'

// Derive the origin for the CSP `frame-src`. Falls back to the raw value rather
// than throwing: a config file is not worth a boot failure here, and the
// validator below already refuses anything that is not an http(s) URL.
export function diagramsEditorOrigin(editorUrl: string): string {
  try {
    return new URL(editorUrl).origin
  } catch {
    return editorUrl
  }
}

export class FilesDiagramsConfig {
  // The env-var spelling is SYNCIN_APPLICATIONS_FILES_DIAGRAMS_EDITORURL — one
  // segment, because `config.loader.ts` splits the name on `_` and matches each
  // segment against a whole key. `..._EDITOR_URL` would not match and would be
  // discarded with a warning, not an error.
  @IsNotEmpty()
  @IsString()
  @Matches(/^https?:\/\/\S+$/, { message: 'applications.files.diagrams.editorUrl must be an http(s) URL' })
  editorUrl: string = DEFAULT_DIAGRAMS_EDITOR_URL
}
