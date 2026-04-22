import { ChangeDetectionStrategy, Component, Input } from '@angular/core'

// Icon names ported from sync-in/project/src/icons.jsx (handoff bundle).
// All icons use a 24×24 viewBox, 1.6 stroke, currentColor, round caps/joins.
export type IconV2Name =
  | 'home'
  | 'folder'
  | 'folderOpen'
  | 'users'
  | 'link'
  | 'trash'
  | 'star'
  | 'search'
  | 'bell'
  | 'settings'
  | 'plus'
  | 'upload'
  | 'download'
  | 'share'
  | 'more'
  | 'chevron'
  | 'chevDown'
  | 'chevUp'
  | 'chevLeft'
  | 'chevRight'
  | 'check'
  | 'x'
  | 'clock'
  | 'list'
  | 'grid'
  | 'gallery'
  | 'filter'
  | 'sort'
  | 'pin'
  | 'eye'
  | 'lock'
  | 'unlock'
  | 'comment'
  | 'refresh'
  | 'arrowUp'
  | 'arrowDown'
  | 'image'
  | 'video'
  | 'doc'
  | 'sheet'
  | 'deck'
  | 'pdf'
  | 'code'
  | 'audio'
  | 'archive'
  | 'sparkle'
  | 'flag'
  | 'activity'
  | 'globe'
  | 'info'
  | 'pencil'
  | 'shareTree'
  | 'at'
  | 'person'
  | 'people'
  | 'box'
  | 'restore'

@Component({
  selector: 'app-v2-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './icon-v2.component.html',
  styles: [
    `
      :host {
        display: inline-flex;
        flex-shrink: 0;
        line-height: 0;
      }
      svg {
        flex-shrink: 0;
        display: block;
      }
    `
  ]
})
export class IconV2Component {
  @Input({ required: true }) name!: IconV2Name
  @Input() size = 18
  @Input() stroke = 1.6
}
