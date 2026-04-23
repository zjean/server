import { Routes } from '@angular/router'
import { KitComponent } from './screens/kit/kit.component'
import { PersonalComponent } from './screens/personal/personal.component'
import { RecentsComponent } from './screens/recents/recents.component'
import { SharedComponent } from './screens/shared/shared.component'
import { SpacesComponent } from './screens/spaces/spaces.component'
import { TrashComponent } from './screens/trash/trash.component'
import { ViewerComponent } from './screens/viewer/viewer.component'
import { V2_ROUTES } from './v2.constants'

export const v2Routes: Routes = [
  { path: V2_ROUTES.STUB, pathMatch: 'full', redirectTo: V2_ROUTES.RECENTS },
  { path: V2_ROUTES.KIT, component: KitComponent },
  { path: V2_ROUTES.RECENTS, component: RecentsComponent },
  { path: V2_ROUTES.VIEWER, component: ViewerComponent },
  {
    path: V2_ROUTES.PERSONAL,
    children: [
      { path: '', component: PersonalComponent },
      { path: '**', component: PersonalComponent }
    ]
  },
  { path: V2_ROUTES.SPACES, component: SpacesComponent },
  {
    path: V2_ROUTES.SHARED,
    pathMatch: 'full',
    redirectTo: V2_ROUTES.SHARED_WITH_ME
  },
  { path: V2_ROUTES.SHARED_WITH_ME, component: SharedComponent, data: { variant: 'with-me' } },
  { path: V2_ROUTES.SHARED_WITH_OTHERS, component: SharedComponent, data: { variant: 'with-others' } },
  { path: V2_ROUTES.SHARED_VIA_LINKS, component: SharedComponent, data: { variant: 'via-links' } },
  { path: V2_ROUTES.TRASH, component: TrashComponent }
]
