import { ChangeDetectionStrategy, Component, computed, inject, OnInit } from '@angular/core'
import { Router } from '@angular/router'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe } from 'angular-l10n'
import { SPACE_ALIAS, SPACE_REPOSITORY } from '@sync-in-server/backend/src/applications/spaces/constants/spaces'
import type { FileFavorite } from '@sync-in-server/backend/src/applications/files/schemas/file-favorite.interface'
import { EmptyStateComponent } from '../../components/empty-state.component'
import { FileRowComponent } from '../../components/file-row.component'
import { SectionHeadComponent } from '../../components/section-head.component'
import { IconV2Component, IconV2Name } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'
import { FILE_ORIGIN_ICONS, FILE_ORIGIN_LABELS, fileOriginFromPath, stripRepositoryPrefix } from '../../utils/file-origin'
import { FavoritesService } from '../../services/favorites.service'

@Component({
  selector: 'app-v2-favorites',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './favorites.component.html',
  styleUrl: './favorites.component.scss',
  imports: [IconV2Component, FileRowComponent, SectionHeadComponent, EmptyStateComponent, L10nTranslateDirective, L10nTranslatePipe]
})
export class FavoritesComponent implements OnInit {
  private readonly favoritesService = inject(FavoritesService)
  private readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  // Upstream marks a favorite the user can no longer reach as isDisabled and leaves
  // its `path` unaddressable, so it is excluded rather than shown as a dead row.
  protected readonly favorites = computed(() => this.favoritesService.favorites().filter((f) => !f.isDisabled))
  protected readonly hasAny = computed(() => this.favorites().length > 0)

  // One instant for the whole list — see the same note in recents.
  protected readonly renderedAt = Date.now()

  private readonly repositories = { files: SPACE_REPOSITORY.FILES as string, shares: SPACE_REPOSITORY.SHARES as string }

  ngOnInit(): void {
    this.breadcrumbs.setBreadcrumbs([{ label: 'Favorites', icon: 'star' }])
    this.favoritesService.loadFavorites()
  }

  // ─── Location, derived the same way recents derives it ────────────────────
  // Upstream's FileFavorite splits the address into `path` (the repository-qualified
  // PARENT) and `name`, which is exactly the shape recents rows have — so the
  // address is parent + name, as in recents.component.ts's serverPath().
  //
  // A row upstream could not resolve to a location comes back isDisabled, and its
  // `path` is then the raw OWNER-relative files.path rather than an addressable
  // repository path. Those rows are dropped in `favorites` below rather than
  // rendered as entries that cannot be opened.

  protected navPath(fav: FileFavorite): string {
    return `${fav.path}/${fav.name}`
  }

  protected originKey(fav: FileFavorite): string {
    return FILE_ORIGIN_LABELS[fileOriginFromPath(this.navPath(fav), this.repositories, SPACE_ALIAS.PERSONAL)]
  }

  protected originIcon(fav: FileFavorite): IconV2Name {
    return FILE_ORIGIN_ICONS[fileOriginFromPath(this.navPath(fav), this.repositories, SPACE_ALIAS.PERSONAL)]
  }

  // dropLast, because the composed path ends in the item's own name and the row
  // already shows that on the line above. Returns '' at a repository root, where the
  // template substitutes the origin label — the previous implementation returned a
  // bare '/' there, which rendered as a stray slash.
  protected locationPath(fav: FileFavorite): string {
    return stripRepositoryPrefix(this.navPath(fav), SPACE_ALIAS.PERSONAL, true)
  }

  // The composed path is a Sync-in repository path:
  //   files/personal/<sub>   → personal browser
  //   files/<alias>/<sub>    → space browser
  //   shares/<alias>/<sub>   → no dedicated v2 per-alias browser; for a
  //                            directory we fall through to the spaces route
  //                            shape (alias-based), which is the closest match.
  // For a file we always open the file-detail route with the full path, exactly
  // as recents does (the FILE screen takes a repository path query param).
  protected openFavorite(fav: FileFavorite): void {
    const navPath = this.navPath(fav)
    if (!fav.path || !fav.name) return
    if (!fav.isDir) {
      this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: { path: navPath } }).catch(console.error)
      return
    }
    const segs = navPath.split('/').filter(Boolean)
    const [repo, alias, ...rest] = segs
    if (repo === SPACE_REPOSITORY.FILES && alias === SPACE_ALIAS.PERSONAL) {
      this.router.navigate(['/', V2_PATH, V2_ROUTES.PERSONAL, ...rest]).catch(console.error)
      return
    }
    if (alias) {
      this.router.navigate(['/', V2_PATH, V2_ROUTES.SPACES, alias, ...rest]).catch(console.error)
    }
  }

  // Middle-click → file-detail in a new tab, files only: a directory's target is a
  // browser route, and opening that in a background tab is not what the gesture
  // means here. The button-number guard now lives in FileRowComponent.
  protected openFavoriteInNewTab(fav: FileFavorite): void {
    if (fav.isDir || !fav.path || !fav.name) return
    if (typeof window === 'undefined') return
    window.open(`/#/${V2_PATH}/${V2_ROUTES.FILE}?path=${encodeURIComponent(this.navPath(fav))}`, '_blank', 'noopener')
  }
}
