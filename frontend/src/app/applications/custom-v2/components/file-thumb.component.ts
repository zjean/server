import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core'
import { API_FILES_OPERATION_THUMBNAIL } from '@sync-in-server/backend/src/applications/files/constants/routes'
import { encodeUrl } from '@sync-in-server/backend/src/common/shared'
import { isImageMime, mimeToGlyph } from '../utils/mime-to-glyph'
import { FileGlyphComponent } from './file-glyph.component'

// Minimal shape FileThumb consumes. Both classic FileModel and the v2 grid's
// raw FileProps satisfy this — keeps the component callable from either
// caller without forcing them to hydrate a full FileModel.
export interface FileThumbInput {
  name: string
  path: string
  mime: string
  isDir: boolean
}

// Card thumbnail for grid + gallery views.
//
// For image mimes, renders a server-side thumbnail (`f.thumbnailUrl?size=N`)
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
  // Glyph dimensions used when the file is not an image, or when the image
  // request fails. The image-fill path ignores this.
  readonly glyphSize = input<number>(38)
  readonly rounded = input<number>(8)
  // Server-side thumbnail dimension. Backend clamps to [32, 1024]. Pick ~2×
  // the rendered size for hi-DPI; 256 covers the 108-px grid header, 512
  // covers the 4:3 gallery stage.
  readonly imageRes = input<number>(256)

  protected readonly errored = signal(false)

  protected readonly showImage = computed(() => {
    const f = this.file()
    return !f.isDir && isImageMime(f.mime) && !this.errored()
  })

  // Compose the URL inline from the path so callers can pass any
  // FileProps-shaped object (the v2 personal grid binds raw FileProps,
  // not a hydrated FileModel; both have `path` and `mime`).
  protected readonly src = computed(() => `${API_FILES_OPERATION_THUMBNAIL}/${encodeUrl(this.file().path)}?size=${this.imageRes()}`)

  protected readonly glyphType = computed(() => {
    const f = this.file()
    return f.isDir ? 'folder' : mimeToGlyph(f.mime)
  })
}
