import { ChangeDetectionStrategy, Component } from '@angular/core'
import { L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { SPACE_ALIAS, SPACE_REPOSITORY } from '@sync-in-server/backend/src/applications/spaces/constants/spaces'
import { Observable } from 'rxjs'
import { ToBytesPipe } from '../../../../common/pipes/to-bytes.pipe'
import { TimeAgoPipe } from '../../../../common/pipes/time-ago.pipe'
import { ActionSheetComponent } from '../../components/action-sheet.component'
import { ButtonComponent } from '../../components/button.component'
import { CheckboxComponent } from '../../components/checkbox.component'
import { ContextMenuComponent } from '../../components/context-menu.component'
import { DropZoneDirective } from '../../components/drop-zone.directive'
import { EmptyStateComponent } from '../../components/empty-state.component'
import { FabComponent } from '../../components/fab.component'
import { FileGlyphComponent } from '../../components/file-glyph.component'
import { FileThumbComponent } from '../../components/file-thumb.component'
import { IconButtonComponent } from '../../components/icon-button.component'
import { PillComponent } from '../../components/pill.component'
import { IconV2Component } from '../../icons/icon-v2.component'
import { BreadcrumbSegment } from '../../layout/breadcrumb.service'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'
import { FileBrowserBase } from '../files/file-browser.base'
import type { FileBrowserRepository } from '../files/file-browser-repository'

// The personal-space file browser. Everything it does lives in FileBrowserBase
// and file-browser.component.html/.scss (shared with SpaceFilesComponent, see
// issue #346); this class is only the repository strategy that says where the
// files come from.
@Component({
  selector: 'app-v2-personal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: '../files/file-browser.component.html',
  styleUrl: '../files/file-browser.component.scss',
  imports: [
    IconV2Component,
    FileGlyphComponent,
    FileThumbComponent,
    ButtonComponent,
    CheckboxComponent,
    IconButtonComponent,
    PillComponent,
    ContextMenuComponent,
    DropZoneDirective,
    EmptyStateComponent,
    FabComponent,
    ActionSheetComponent,
    ToBytesPipe,
    TimeAgoPipe,
    L10nTranslateDirective,
    L10nTranslatePipe
  ]
})
export class PersonalComponent extends FileBrowserBase {
  // Platform-aware label for the filter shortcut hint. The kbd badge next to
  // the filter input promises ⌘F (or Ctrl-F on non-Mac); the base's keydown
  // handler delivers on it because filterShortcutEnabled is true below.
  protected readonly filterShortcutLabel: string = (() => {
    if (typeof navigator === 'undefined') return 'Ctrl F'
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '') || /Mac/.test(navigator.userAgent || '')
    return isMac ? '⌘F' : 'Ctrl F'
  })()

  private readonly personalRoot = [SPACE_REPOSITORY.FILES, SPACE_ALIAS.PERSONAL].join('/')

  protected readonly repository: FileBrowserRepository = {
    // Personal is always the personal space, so the alias is a constant rather
    // than a route-derived signal — and can therefore never be empty, which is
    // why none of the base's empty-alias guards ever fire here.
    alias: (): string => SPACE_ALIAS.PERSONAL,

    // Personal files carry NO space descriptor, and DO carry the owner id. The
    // space-files screen is the exact inverse. Neither is inferable from the
    // dialogs' DTO types — see CLAUDE.md on classic-UI-as-ground-truth.
    dialogSpace: (): unknown => null,
    dialogOwnerId: (): number | null => this.store.user.getValue()?.id ?? null,
    compressRootAlias: (): string => SPACE_ALIAS.PERSONAL,

    folderRoute: (segments: readonly string[]): unknown[] => ['/', V2_PATH, V2_ROUTES.PERSONAL, ...segments],

    // targetPath is the Sync-in absolute directory path each breadcrumb segment
    // represents — set so the segment can act as a drop target for
    // drag-and-drop moves. The terminal segment's targetPath equals the current
    // sourceDir, so V2DragService.canDropOnPath naturally rejects it as a no-op
    // without per-segment "is current?" gating here.
    breadcrumbs: (segments: readonly string[]): BreadcrumbSegment[] => [
      {
        label: 'Personal',
        icon: 'folder',
        route: ['/', V2_PATH, V2_ROUTES.PERSONAL],
        targetPath: this.personalRoot
      },
      ...segments.map((seg, i) => {
        const slice = segments.slice(0, i + 1)
        return {
          label: seg,
          route: ['/', V2_PATH, V2_ROUTES.PERSONAL, ...slice],
          targetPath: [this.personalRoot, ...slice].join('/')
        }
      })
    ],

    // Only the url can change — there is no alias param to watch.
    navigation: (): Observable<unknown> => this.route.url,

    rootLabel: (): string => 'Personal',
    translateRootLabel: true,
    // Lower-case: the archive name is a filename, not a title.
    rootArchiveName: (): string => SPACE_ALIAS.PERSONAL,
    filterPlaceholder: 'Filter in Personal…',
    filterHint: (): string => this.filterShortcutLabel,

    filterShortcutEnabled: true,
    showDownloadFromUrlAction: true,
    // NOTE: space-files auto-downloads a finished compress archive and personal
    // does not. Preserved as-is by #346; almost certainly a gap in personal, but
    // fixing it is a behaviour change and belongs in its own PR.
    autoDownloadTaskArchive: false,
    // The action sheet also closes itself via its (closed) output, so this only
    // affects who clears the signal first.
    closeActionSheetOnSelect: false
  }

  protected viewModeStorageKey(): string {
    return 'ui.personal.viewMode'
  }
}
