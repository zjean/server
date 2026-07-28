import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { SPACE_REPOSITORY } from '@sync-in-server/backend/src/applications/spaces/constants/spaces'
import { combineLatest, Observable, Subscription } from 'rxjs'
import { ToBytesPipe } from '../../../../common/pipes/to-bytes.pipe'
import { TimeAgoPipe } from '../../../../common/pipes/time-ago.pipe'
import { SpacesService } from '../../../spaces/services/spaces.service'
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

// The space file browser. Everything it does lives in FileBrowserBase and
// file-browser.component.html/.scss (shared with PersonalComponent, see issue
// #346); this class is only the repository strategy — a route-derived alias, the
// space-name lookup that alias needs, and the wire identity of a space file.
@Component({
  selector: 'app-v2-space-files',
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
export class SpaceFilesComponent extends FileBrowserBase {
  private readonly spacesService = inject(SpacesService)
  private spaceSubscription: Subscription | null = null

  protected readonly alias = toSignal(this.route.params, { initialValue: {} as { alias?: string } })
  protected readonly spaceName = signal<string>('')

  protected readonly repository: FileBrowserRepository = {
    // '' until the route param resolves; the base treats that as "cannot
    // address the backend yet" and skips loading, navigation and breadcrumbs.
    alias: (): string => this.alias().alias ?? '',

    // Space files DO carry a space descriptor and DELIBERATELY send
    // ownerId: null even when a user is logged in — personal is the exact
    // inverse. Neither is inferable from the dialogs' DTO types.
    dialogSpace: (): unknown => {
      const alias = this.repository.alias()
      const name = this.spaceName() || alias
      return { alias, name, root: { alias, name } }
    },
    dialogOwnerId: (): number | null => null,
    compressRootAlias: (): string => this.repository.alias(),

    folderRoute: (segments: readonly string[]): unknown[] => ['/', V2_PATH, V2_ROUTES.SPACES, this.repository.alias(), ...segments],

    // targetPath maps each routable segment to a Sync-in absolute directory path
    // so the segment can act as a drop target for drag-and-drop moves. The
    // Spaces *index* (top of the breadcrumb) intentionally has no targetPath —
    // you can't drop a file *onto* "the list of spaces"; it's not a directory.
    // The space root and folder trail do.
    breadcrumbs: (segments: readonly string[]): BreadcrumbSegment[] => {
      const alias = this.repository.alias()
      const spaceRootPath = [SPACE_REPOSITORY.FILES, alias].join('/')
      return [
        { label: 'Spaces', icon: 'box', route: ['/', V2_PATH, V2_ROUTES.SPACES] },
        { label: this.spaceName() || alias, route: ['/', V2_PATH, V2_ROUTES.SPACES, alias], targetPath: spaceRootPath },
        ...segments.map((seg, i) => {
          const slice = segments.slice(0, i + 1)
          return {
            label: seg,
            route: ['/', V2_PATH, V2_ROUTES.SPACES, alias, ...slice],
            targetPath: [spaceRootPath, ...slice].join('/')
          }
        })
      ]
    },

    // Both the params and the url matter: switching spaces keeps this component
    // instance alive and only changes the alias param.
    navigation: (): Observable<unknown> => combineLatest([this.route.params, this.route.url]),

    rootLabel: (): string => this.spaceName() || this.repository.alias(),
    // A space name is user data, never an i18n key.
    translateRootLabel: false,
    rootArchiveName: (): string => this.spaceName() || this.repository.alias(),
    filterPlaceholder: 'Filter in this space…',
    // Hard-coded, unlike personal's platform-aware label — and the shortcut it
    // advertises is not wired up (filterShortcutEnabled is false). Preserved
    // verbatim by #346; reported as a separate bug.
    filterHint: (): string => '⌘F',

    filterShortcutEnabled: false,
    showDownloadFromUrlAction: false,
    autoDownloadTaskArchive: true,
    closeActionSheetOnSelect: true,

    // The space name is not on the browse response, so it is fetched once the
    // listing confirms the alias is real, then the breadcrumbs are re-published
    // with the resolved name.
    onListingLoaded: (alias: string): void => {
      if (!this.spaceName()) this.loadSpaceName(alias)
    },

    onDestroy: (): void => {
      this.spaceSubscription?.unsubscribe()
    }
  }

  protected viewModeStorageKey(): string {
    return 'ui.space.viewMode'
  }

  private loadSpaceName(alias: string): void {
    this.spaceSubscription?.unsubscribe()
    this.spaceSubscription = this.spacesService.listSpaces().subscribe({
      next: (spaces) => {
        const match = spaces.find((s) => s.alias === alias)
        if (match) {
          this.spaceName.set(match.name || alias)
          this.syncBreadcrumbs()
        }
      }
    })
  }
}
