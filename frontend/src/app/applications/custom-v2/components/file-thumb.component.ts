import { ChangeDetectionStrategy, Component, computed, input, linkedSignal } from '@angular/core'
import { API_FILES_OPERATION_THUMBNAIL } from '@sync-in-server/backend/src/applications/files/constants/routes'
import { encodeUrl } from '@sync-in-server/backend/src/common/shared'
import { isImageMime, mimeToGlyph } from '../utils/mime-to-glyph'
import { FileGlyphComponent } from './file-glyph.component'

// Minimal shape FileThumb consumes. Both classic FileModel and the v2 grid's
// raw FileProps satisfy this — keeps the component callable from either
// caller without forcing them to hydrate a full FileModel.
//
// `path` is deliberately NOT part of it: on a raw browse row `path` is the
// PARENT directory relative to the repository root, so it is not an address, and
// reaching for it is the bug #428 fixed. The address arrives as `serverPath`.
export interface FileThumbInput {
  name: string
  mime: string
  isDir: boolean
}

// Thumbnail URL for an addressable, repository-qualified file path.
//
// Same composition classic uses — `FileModel.thumbnailUrl`
// (files/models/file.model.ts:113) is `${API_FILES_OPERATION_THUMBNAIL}/${encodeUrl(path)}`
// and both classic call sites append `?size=N`
// (spaces-browser.component.html:231, files-selection.component.html:30).
export function fileThumbnailUrl(serverPath: string, size: number): string {
  return `${API_FILES_OPERATION_THUMBNAIL}/${encodeUrl(serverPath)}?size=${size}`
}

// Card thumbnail for grid + gallery views.
//
// For image mimes, renders a server-side thumbnail (`fileThumbnailUrl`, the
// same URL classic's `FileModel.thumbnailUrl` produces)
// that fills the parent slot via absolute positioning. On 404/network error,
// flips to the same FileGlyph the rest of v2 uses, so the cell never goes
// empty.
//
// Image-fill mode requires a positioned containing block (the parent must be
// `position: relative`) — true today for `.file-card__header` and
// `.gallery-card__stage`. Caller is responsible for ensuring decorative
// overlays (pills, tags) stack above via z-index when needed.
@Component({
  selector: 'app-v2-file-thumb',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FileGlyphComponent],
  template: `
    @if (showImage()) {
      <img
        class="v2-file-thumb__img"
        [src]="src()"
        [alt]="file().name"
        loading="lazy"
        decoding="async"
        draggable="false"
        (error)="errored.set(true)"
      />
    } @else {
      <app-v2-file-glyph [type]="glyphType()" [size]="glyphSize()" [rounded]="rounded()" />
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }
      .v2-file-thumb__img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
    `
  ]
})
export class FileThumbComponent {
  readonly file = input.required<FileThumbInput>()
  // The addressable, repository-qualified path of this file —
  // `files/<alias>/<dirs>/<name>` (or `shares/<alias>/…`). Required, and
  // supplied by the caller rather than derived from `file()`: the repository
  // prefix is a fact about the SCREEN, not about the row, and the browse API
  // splits the rest of the path across `path` (parent dir) and `name`.
  //
  // Classic reaches the same address from `FileModel.path`, which the
  // FileModel constructor has already prefixed with the parent's basePath
  // (files/models/file.model.ts:92). Issue #428 — before this input existed the
  // component built the URL from the raw `file().path`, so every cell in a
  // folder requested the parent directory, got a 403, and fell back to a glyph.
  readonly serverPath = input.required<string>()
  // Glyph dimensions used when the file is not an image, or when the image
  // request fails. The image-fill path ignores this.
  readonly glyphSize = input<number>(38)
  readonly rounded = input<number>(8)
  // Server-side thumbnail dimension. Backend clamps to [32, 1024]. Pick ~2×
  // the rendered size for hi-DPI; 256 covers the 108-px grid header, 512
  // covers the 4:3 gallery stage.
  readonly imageRes = input<number>(256)

  // Resets whenever the URL changes: rows are tracked by id across a refresh,
  // so a plain signal would latch the glyph for the component's lifetime even
  // after the address it failed on stopped being the one we ask for (a rename
  // keeps the id and changes the name).
  protected readonly errored = linkedSignal<string, boolean>({ source: () => this.src(), computation: () => false })

  protected readonly showImage = computed(() => {
    const f = this.file()
    return !f.isDir && isImageMime(f.mime) && !!this.serverPath() && !this.errored()
  })

  protected readonly src = computed(() => fileThumbnailUrl(this.serverPath(), this.imageRes()))

  protected readonly glyphType = computed(() => {
    const f = this.file()
    return f.isDir ? 'folder' : mimeToGlyph(f.mime)
  })
}
