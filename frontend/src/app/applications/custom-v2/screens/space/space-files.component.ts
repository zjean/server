import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { SPACE_REPOSITORY } from '@sync-in-server/backend/src/applications/spaces/constants/spaces'
import { combineLatest, Observable, Subscription } from 'rxjs'
import { tap } from 'rxjs/operators'
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
import { FolderReadmeComponent } from '../../components/folder-readme.component'
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
    // Declared here purely because the shared template renders
    // <app-v2-folder-readme>; the wiring behind it is entirely in
    // FileBrowserBase, same as for every other component in this list.
    FolderReadmeComponent,
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
    //
    // The tap is the space-name reset, and it has to happen HERE rather than in
    // onListingLoaded: the base syncs breadcrumbs before it loads the listing, so
    // a reset that waited for the response would publish the previous space's
    // name into the trail first. See resetSpaceNameOnAliasChange.
    navigation: (): Observable<unknown> => combineLatest([this.route.params, this.route.url]).pipe(tap(() => this.resetSpaceNameOnAliasChange())),

    rootLabel: (): string => this.spaceName() || this.repository.alias(),
    // A space name is user data, never an i18n key.
    translateRootLabel: false,
    rootArchiveName: (): string => this.spaceName() || this.repository.alias(),
    filterPlaceholder: 'Filter in this space…',
    // Shared with personal via the base, so the hint names the key the platform
    // actually uses. Was a hard-coded '⌘F' advertising a shortcut that had no
    // handler behind it — filterShortcutEnabled was false (#368).
    filterHint: (): string => this.filterShortcutLabel,

    filterShortcutEnabled: true,
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

  // Angular reuses this component across any hop that stays within the single
  // `path: '**'` route entry (v2.routes.ts) — root->subfolder and subfolder->root
  // included, since the folder-readme work collapsed each browse screen to one
  // entry (design §5 of docs/plans/2026-07-28-v2-folder-readme-design.md). That
  // reuse is also what makes a *space->space* hop reuse the component whenever one
  // side of the hop is root and the other a subfolder — the two shapes that used
  // to cross a route boundary and get recreated. onListingLoaded only fetches the
  // space name when spaceName() is empty, so without this reset the
  // breadcrumb/title kept showing the PREVIOUS space's name after such a hop.
  private lastSpaceAlias: string | null = null

  private resetSpaceNameOnAliasChange(): void {
    const alias = this.repository.alias()
    if (alias === this.lastSpaceAlias) return
    this.lastSpaceAlias = alias
    this.spaceName.set('')
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
