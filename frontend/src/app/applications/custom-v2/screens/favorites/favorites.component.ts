import { ChangeDetectionStrategy, Component, computed, inject, OnInit } from '@angular/core'
import { Router } from '@angular/router'
import { L10nTranslateDirective } from 'angular-l10n'
import { SPACE_ALIAS, SPACE_REPOSITORY } from '@sync-in-server/backend/src/applications/spaces/constants/spaces'
import type { FileFavorite } from '@sync-in-server/backend/src/applications/custom-favorites/interfaces/file-favorite.interface'
import { TimeAgoPipe } from '../../../../common/pipes/time-ago.pipe'
import { EmptyStateComponent } from '../../components/empty-state.component'
import { FileGlyphComponent } from '../../components/file-glyph.component'
import { IconV2Component } from '../../icons/icon-v2.component'
import { V2BreadcrumbService } from '../../layout/breadcrumb.service'
import { V2_PATH, V2_ROUTES } from '../../v2.constants'
import { mimeToGlyph } from '../../utils/mime-to-glyph'
import { FavoritesService } from '../../services/favorites.service'

@Component({
  selector: 'app-v2-favorites',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './favorites.component.html',
  styleUrl: './favorites.component.scss',
  imports: [IconV2Component, FileGlyphComponent, TimeAgoPipe, L10nTranslateDirective, EmptyStateComponent]
})
export class FavoritesComponent implements OnInit {
  private readonly favoritesService = inject(FavoritesService)
  private readonly router = inject(Router)
  private readonly breadcrumbs = inject(V2BreadcrumbService)

  protected readonly mimeToGlyph = mimeToGlyph
  protected readonly favorites = this.favoritesService.favorites
  protected readonly hasAny = computed(() => this.favorites().length > 0)

  ngOnInit(): void {
    this.breadcrumbs.setBreadcrumbs([{ label: 'Favorites', icon: 'star' }])
    this.favoritesService.loadFavorites()
  }

  // navPath is a Sync-in repository path:
  //   files/personal/<sub>   → personal browser
  //   files/<alias>/<sub>    → space browser
  //   shares/<alias>/<sub>   → no dedicated v2 per-alias browser; for a
  //                            directory we fall through to the spaces route
  //                            shape (alias-based), which is the closest match.
  // For a file we always open the file-detail route with the full path, exactly
  // as recents does (the FILE screen takes a repository path query param).
  protected openFavorite(fav: FileFavorite): void {
    if (!fav.navPath) return
    if (!fav.isDir) {
      this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: { path: fav.navPath } }).catch(console.error)
      return
    }
    const segs = fav.navPath.split('/').filter(Boolean)
    const [repo, alias, ...rest] = segs
    if (repo === SPACE_REPOSITORY.FILES && alias === SPACE_ALIAS.PERSONAL) {
      this.router.navigate(['/', V2_PATH, V2_ROUTES.PERSONAL, ...rest]).catch(console.error)
      return
    }
    if (alias) {
      this.router.navigate(['/', V2_PATH, V2_ROUTES.SPACES, alias, ...rest]).catch(console.error)
    }
  }

  // Middle-click on a favorite row → new tab with file-detail (files only).
  protected onRowAuxClick(event: MouseEvent, fav: FileFavorite): void {
    if (event.button !== 1 || fav.isDir || !fav.navPath) return
    event.preventDefault()
    if (typeof window !== 'undefined') {
      window.open(`/#/${V2_PATH}/${V2_ROUTES.FILE}?path=${encodeURIComponent(fav.navPath)}`, '_blank', 'noopener')
    }
  }

  // Trim the trailing file/folder name to surface the parent path under the
  // row name, mirroring recents' showedPath sub-line.
  protected parentPath(fav: FileFavorite): string {
    const segs = fav.navPath.split('/').filter(Boolean)
    segs.pop()
    return segs.length ? segs.join('/') : '/'
  }
}
