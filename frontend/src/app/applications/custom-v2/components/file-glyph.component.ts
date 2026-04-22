import { ChangeDetectionStrategy, Component, computed, Input, input } from '@angular/core'
import { IconV2Component, IconV2Name } from '../icons/icon-v2.component'

export type FileGlyphType = 'image' | 'video' | 'doc' | 'sheet' | 'deck' | 'pdf' | 'code' | 'audio' | 'archive' | 'folder' | 'default'

const TYPE_TO_ICON: Record<FileGlyphType, IconV2Name> = {
  image: 'image',
  video: 'video',
  doc: 'doc',
  sheet: 'sheet',
  deck: 'deck',
  pdf: 'pdf',
  code: 'code',
  audio: 'audio',
  archive: 'archive',
  folder: 'folder',
  default: 'doc'
}

@Component({
  selector: 'app-v2-file-glyph',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconV2Component],
  template: `
    <div
      class="glyph"
      [style.width.px]="size()"
      [style.height.px]="size()"
      [style.border-radius.px]="rounded"
      [style.background]="'var(' + bgVar() + ')'"
      [style.color]="'var(' + fgVar() + ')'"
    >
      <app-v2-icon [name]="iconName()" [size]="iconSize()" />
    </div>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        flex-shrink: 0;
      }
      .glyph {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
      }
    `
  ]
})
export class FileGlyphComponent {
  readonly type = input<FileGlyphType>('default')
  readonly size = input<number>(32)
  @Input() rounded = 7

  readonly iconName = computed<IconV2Name>(() => TYPE_TO_ICON[this.type()])
  readonly iconSize = computed(() => Math.round(this.size() * 0.5))
  readonly bgVar = computed(() => `--fc-${this.type()}-bg`)
  readonly fgVar = computed(() => `--fc-${this.type()}-fg`)
}
