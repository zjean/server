import { Routes } from '@angular/router'
import { AdminComponent } from './screens/admin/admin.component'
import { AdminGroupsComponent } from './screens/admin/admin-groups.component'
import { AdminSpacesComponent } from './screens/admin/admin-spaces.component'
import { AdminToolsComponent } from './screens/admin/admin-tools.component'
import { AdminUsersComponent } from './screens/admin/admin-users.component'
import { FavoritesComponent } from './screens/favorites/favorites.component'
import { FileDetailComponent } from './screens/file-detail/file-detail.component'
import { GroupsComponent } from './screens/groups/groups.component'
import { KitComponent } from './screens/kit/kit.component'
import { PeopleComponent } from './screens/people/people.component'
import { PersonalComponent } from './screens/personal/personal.component'
import { RecentsComponent } from './screens/recents/recents.component'
import { SearchComponent } from './screens/search/search.component'
import { SettingsComponent } from './screens/settings/settings.component'
import { SharedComponent } from './screens/shared/shared.component'
import { SpaceFilesComponent } from './screens/space/space-files.component'
import { SpacesComponent } from './screens/spaces/spaces.component'
import { TrashComponent } from './screens/trash/trash.component'
import { TrashBinComponent } from './screens/trash-bin/trash-bin.component'
import { V2_ROUTES } from './v2.constants'

export const v2Routes: Routes = [
  { path: V2_ROUTES.STUB, pathMatch: 'full', redirectTo: V2_ROUTES.RECENTS },
  { path: V2_ROUTES.KIT, component: KitComponent },
  { path: V2_ROUTES.RECENTS, component: RecentsComponent },
  { path: V2_ROUTES.FAVORITES, component: FavoritesComponent },
  { path: V2_ROUTES.FILE, component: FileDetailComponent },
  // ONE child entry per browse screen, deliberately. With a separate `path: ''`
  // alongside `path: '**'`, navigating between the root and a subfolder crosses
  // two different route configs, so Angular destroys and recreates the component
  // instead of reusing it. Both screens are built to reload in place (they
  // subscribe to route.url), and the folder-readme banner's auto-save-on-navigate
  // only runs when the component survives the hop — with two entries an unsaved
  // readme edit was silently lost on root<->subfolder. '**' matches the empty
  // path too, so one entry covers both. Keep the `children` wrapper: the screens'
  // pathSegments read the CHILD's route.url, which must exclude this path prefix.
  {
    path: V2_ROUTES.PERSONAL,
    children: [{ path: '**', component: PersonalComponent }]
  },
  { path: V2_ROUTES.SPACES, pathMatch: 'full', component: SpacesComponent },
  {
    path: `${V2_ROUTES.SPACES}/:alias`,
    children: [{ path: '**', component: SpaceFilesComponent }]
  },
  {
    path: V2_ROUTES.SHARED,
    pathMatch: 'full',
    redirectTo: V2_ROUTES.SHARED_WITH_ME
  },
  { path: V2_ROUTES.SHARED_WITH_ME, component: SharedComponent, data: { variant: 'with-me' } },
  { path: V2_ROUTES.SHARED_WITH_OTHERS, component: SharedComponent, data: { variant: 'with-others' } },
  { path: V2_ROUTES.SHARED_VIA_LINKS, component: SharedComponent, data: { variant: 'via-links' } },
  { path: V2_ROUTES.TRASH, pathMatch: 'full', component: TrashComponent },
  // Deliberately KEPT as two entries, unlike PERSONAL/SPACES above: TrashBinComponent
  // has the identical in-place-reload construction (a combineLatest([route.params,
  // route.url]) subscription, trash-bin.component.ts:112) as SpaceFilesComponent, so
  // its root<->subfolder hop still crosses a route boundary and destroys/recreates the
  // screen — the same "identical navigation, different outcome depending on whether the
  // hop crossed a route config" that motivated collapsing PERSONAL and SPACES (§5 of
  // docs/plans/2026-07-28-v2-folder-readme-design.md). It is harmless here: no folder
  // readme banner lives on this screen, TrashBinComponent holds no unsaved editor state
  // that a destroy-and-recreate could lose, so there is nothing this inconsistency can
  // silently discard. Collapsing it to one entry to match would need its own
  // verification pass, which is out of scope for the readme-banner work that motivated
  // this comment — left as a known, deliberate inconsistency rather than silently
  // "fixed" to look uniform.
  {
    path: `${V2_ROUTES.TRASH}/:alias`,
    children: [
      { path: '', component: TrashBinComponent },
      { path: '**', component: TrashBinComponent }
    ]
  },
  { path: V2_ROUTES.SEARCH, component: SearchComponent },
  { path: V2_ROUTES.SETTINGS, component: SettingsComponent },
  { path: V2_ROUTES.PEOPLE, component: PeopleComponent },
  // Same one-'**'-child shape as PERSONAL and SPACES above, for the same reason:
  // root ('/v2/groups') and inside-a-group ('/v2/groups/<name>') are one component
  // that reloads in place off route.url, so both levels must resolve through a
  // SINGLE route config or Angular destroys and recreates it on every hop.
  {
    path: V2_ROUTES.GROUPS,
    children: [{ path: '**', component: GroupsComponent }]
  },
  { path: V2_ROUTES.ADMIN, pathMatch: 'full', component: AdminComponent },
  { path: V2_ROUTES.ADMIN_USERS, component: AdminUsersComponent },
  { path: V2_ROUTES.ADMIN_GROUPS, component: AdminGroupsComponent },
  { path: V2_ROUTES.ADMIN_SPACES, component: AdminSpacesComponent },
  { path: V2_ROUTES.ADMIN_TOOLS, component: AdminToolsComponent }
]
