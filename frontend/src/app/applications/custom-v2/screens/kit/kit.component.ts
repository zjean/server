import { ChangeDetectionStrategy, Component } from '@angular/core'
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
export class KitComponent {
  // Mirrors the ladders in _tokens.scss. The `use` column is what each step is
  // for, so the page answers "which token do I reach for" and not just "what
  // sizes exist".
  readonly typeScale = [
    { token: '--si-text-1', px: '9.5px', use: 'Chrome eyebrow' },
    { token: '--si-text-2', px: '10px', use: 'Kbd hint, usage readout' },
    { token: '--si-text-3', px: '10.5px', use: 'Table header, chip' },
    { token: '--si-text-4', px: '11px', use: 'Eyebrow, count pill' },
    { token: '--si-text-5', px: '11.5px', use: 'Card path, segmented button' },
    { token: '--si-text-6', px: '12px', use: 'Dense metadata' },
    { token: '--si-text-7', px: '12.5px', use: 'Comment body' },
    { token: '--si-text-8', px: '13px', use: 'Default control text' },
    { token: '--si-text-9', px: '13.5px', use: 'Row name, breadcrumb' },
    { token: '--si-text-10', px: '14px', use: 'Page meta, input' },
    { token: '--si-text-11', px: '15px', use: 'Prose body, card title' },
    { token: '--si-text-12', px: '18px', use: 'Dialog heading' },
    { token: '--si-text-13', px: '20px', use: 'Section heading' },
    { token: '--si-text-14', px: '22px', use: 'Secondary page title' },
    { token: '--si-text-15', px: '26px', use: 'Page title' }
  ]

  readonly spaceScale = Array.from({ length: 13 }, (_, i) => ({
    token: `--si-space-${i + 1}`,
    px: ['2px', '4px', '6px', '8px', '10px', '12px', '14px', '16px', '18px', '20px', '24px', '28px', '32px'][i]
  }))

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
