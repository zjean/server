import { ChangeDetectionStrategy, Component, inject, OnInit } from '@angular/core'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { AvatarStackComponent, AvatarStackUser } from '../../components/avatar-stack.component'
import { AvatarComponent, AvatarUser } from '../../components/avatar.component'
import { ButtonComponent, ButtonKind, ButtonSize } from '../../components/button.component'
import { FileGlyphComponent, FileGlyphType } from '../../components/file-glyph.component'
import { IconButtonComponent } from '../../components/icon-button.component'
import { LogoComponent } from '../../components/logo.component'
import { PillComponent, PillColor } from '../../components/pill.component'
import { IconV2Component, IconV2Name } from '../../icons/icon-v2.component'

@Component({
  selector: 'app-v2-kit',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './kit.component.html',
  styleUrl: './kit.component.scss',
  imports: [
    IconV2Component,
    AvatarComponent,
    AvatarStackComponent,
    FileGlyphComponent,
    LogoComponent,
    PillComponent,
    ButtonComponent,
    IconButtonComponent
  ]
})
export class KitComponent implements OnInit {
  private readonly breadcrumbs = inject(V2BreadcrumbService)

  // Every other screen sets its own breadcrumb; this one did not, so the bar
  // kept whatever the previous route left there — landing on /v2/_kit from
  // Recents showed "Recents" above the Component kit (#399).
  ngOnInit(): void {
    this.breadcrumbs.setBreadcrumbs([{ label: 'Component kit', icon: 'sparkle' }])
  }

  readonly iconNames: IconV2Name[] = [
    'home',
    'folder',
    'folderOpen',
    'users',
    'link',
    'trash',
    'star',
    'search',
    'bell',
    'settings',
    'plus',
    'upload',
    'download',
    'share',
    'more',
    'chevron',
    'chevDown',
    'chevUp',
    'chevLeft',
    'chevRight',
    'check',
    'x',
    'clock',
    'list',
    'grid',
    'gallery',
    'filter',
    'sort',
    'pin',
    'eye',
    'lock',
    'unlock',
    'comment',
    'refresh',
    'arrowUp',
    'arrowDown',
    'image',
    'video',
    'doc',
    'sheet',
    'deck',
    'pdf',
    'code',
    'audio',
    'archive',
    'sparkle',
    'flag',
    'activity',
    'globe',
    'info',
    'pencil',
    'shareTree',
    'at',
    'person',
    'people',
    'box',
    'restore'
  ]

  readonly fileTypes: FileGlyphType[] = ['image', 'video', 'doc', 'sheet', 'deck', 'pdf', 'code', 'audio', 'archive', 'folder', 'default']

  readonly pillColors: PillColor[] = ['gray', 'indigo', 'green', 'amber', 'rose', 'violet', 'cyan', 'warm']

  readonly buttonKinds: ButtonKind[] = ['primary', 'secondary', 'ghost', 'outline', 'danger']
  readonly buttonSizes: ButtonSize[] = ['xs', 'sm', 'md', 'lg']

  readonly soloAvatar: AvatarUser = { initials: 'JW', hue: 55 }
  readonly ringedAvatar: AvatarUser = { initials: 'AM', hue: 265 }

  readonly stackUsers: AvatarStackUser[] = [
    { id: 1, initials: 'JW', hue: 55 },
    { id: 2, initials: 'AM', hue: 265 },
    { id: 3, initials: 'RL', hue: 155 },
    { id: 4, initials: 'TK', hue: 305 },
    { id: 5, initials: 'NB', hue: 20 }
  ]
}
