import { Routes } from '@angular/router'
import { APP_PATH } from './app.constants'
import { adminRoutes } from './applications/admin/admin.routes'
import { LayoutV2Component } from './applications/custom-v2/layout/layout-v2.component'
import { PreviewPageComponent } from './applications/custom-v2/preview/preview-page.component'
import { uiVersionGuard } from './applications/custom-v2/ui-version.guard'
import { V2_PATH, V2_ROUTES } from './applications/custom-v2/v2.constants'
import { v2Routes } from './applications/custom-v2/v2.routes'
import { favoritesRoutes } from './applications/favorites/favorites.routes'
import { linksRoutes } from './applications/links/links.routes'
import { RECENTS_PATH } from './applications/recents/recents.constants'
import { recentsRoutes } from './applications/recents/recents.routes'
import { searchRoutes } from './applications/search/search.routes'
import { spacesRoutes } from './applications/spaces/spaces.routes'
import { syncRoutes } from './applications/sync/sync.routes'
import { userRoutes } from './applications/users/user.routes'
import { authGuard } from './auth/auth.guards'
import { authRoutes } from './auth/auth.routes'
import { LayoutComponent } from './layout/layout.component'

export const routes: Routes = [
  {
    // Standalone (chromeless) preview route — what middle-click /
    // window.open lands on. Sibling of the v2 layout so the new tab has
    // no v2 sidebar/header. Image + pdf wired in Phases A/B; office and
    // text/code arrive in C/D.
    path: `${V2_PATH}/${V2_ROUTES.PREVIEW}`,
    component: PreviewPageComponent,
    canActivate: [authGuard]
  },
  {
    path: V2_PATH,
    component: LayoutV2Component,
    canActivate: [authGuard],
    children: v2Routes
  },
  {
    path: APP_PATH.BASE,
    component: LayoutComponent,
    canActivate: [authGuard, uiVersionGuard],
    children: [...recentsRoutes, ...favoritesRoutes, ...searchRoutes, ...spacesRoutes, ...userRoutes, ...syncRoutes, ...adminRoutes]
  },
  ...authRoutes,
  ...linksRoutes,
  { path: '**', redirectTo: RECENTS_PATH.BASE }
]
