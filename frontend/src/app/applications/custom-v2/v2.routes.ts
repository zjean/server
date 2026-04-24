import { Routes } from '@angular/router'
import { AdminComponent } from './screens/admin/admin.component'
import { AdminGroupsComponent } from './screens/admin/admin-groups.component'
import { AdminSpacesComponent } from './screens/admin/admin-spaces.component'
import { AdminToolsComponent } from './screens/admin/admin-tools.component'
import { AdminUsersComponent } from './screens/admin/admin-users.component'
import { FileDetailComponent } from './screens/file-detail/file-detail.component'
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
import { ViewerComponent } from './screens/viewer/viewer.component'
import { V2_ROUTES } from './v2.constants'

export const v2Routes: Routes = [
  { path: V2_ROUTES.STUB, pathMatch: 'full', redirectTo: V2_ROUTES.RECENTS },
  { path: V2_ROUTES.KIT, component: KitComponent },
  { path: V2_ROUTES.RECENTS, component: RecentsComponent },
  { path: V2_ROUTES.VIEWER, component: ViewerComponent },
  { path: V2_ROUTES.FILE, component: FileDetailComponent },
  {
    path: V2_ROUTES.PERSONAL,
    children: [
      { path: '', component: PersonalComponent },
      { path: '**', component: PersonalComponent }
    ]
  },
  { path: V2_ROUTES.SPACES, pathMatch: 'full', component: SpacesComponent },
  {
    path: `${V2_ROUTES.SPACES}/:alias`,
    children: [
      { path: '', component: SpaceFilesComponent },
      { path: '**', component: SpaceFilesComponent }
    ]
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
  { path: V2_ROUTES.ADMIN, pathMatch: 'full', component: AdminComponent },
  { path: V2_ROUTES.ADMIN_USERS, component: AdminUsersComponent },
  { path: V2_ROUTES.ADMIN_GROUPS, component: AdminGroupsComponent },
  { path: V2_ROUTES.ADMIN_SPACES, component: AdminSpacesComponent },
  { path: V2_ROUTES.ADMIN_TOOLS, component: AdminToolsComponent }
]
