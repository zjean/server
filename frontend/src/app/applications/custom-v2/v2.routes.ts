import { Routes } from '@angular/router'
import { KitComponent } from './screens/kit/kit.component'
import { PlaceholderComponent, PlaceholderRouteData } from './screens/placeholder/placeholder.component'
import { RecentsComponent } from './screens/recents/recents.component'
import { V2_ROUTES } from './v2.constants'

const placeholder = (data: PlaceholderRouteData) => ({
  component: PlaceholderComponent,
  data: { placeholder: data }
})

export const v2Routes: Routes = [
  { path: V2_ROUTES.STUB, pathMatch: 'full', redirectTo: V2_ROUTES.RECENTS },
  { path: V2_ROUTES.KIT, component: KitComponent },
  { path: V2_ROUTES.RECENTS, component: RecentsComponent },
  {
    path: V2_ROUTES.PERSONAL,
    ...placeholder({
      title: 'Personal',
      icon: 'folder',
      classicRoute: '/files/personal',
      description: 'The redesigned Personal browser is being built. Use the classic version in the meantime.'
    })
  },
  {
    path: V2_ROUTES.SPACES,
    ...placeholder({
      title: 'Spaces',
      icon: 'box',
      classicRoute: '/spaces',
      description: 'Spaces will ship in a later milestone.'
    })
  },
  {
    path: V2_ROUTES.SHARED,
    pathMatch: 'full',
    redirectTo: V2_ROUTES.SHARED_WITH_ME
  },
  {
    path: V2_ROUTES.SHARED_WITH_ME,
    ...placeholder({ title: 'Shared with me', icon: 'person' })
  },
  {
    path: V2_ROUTES.SHARED_WITH_OTHERS,
    ...placeholder({ title: 'Shared with others', icon: 'arrowUp' })
  },
  {
    path: V2_ROUTES.SHARED_VIA_LINKS,
    ...placeholder({ title: 'Shared via links', icon: 'link' })
  },
  {
    path: V2_ROUTES.TRASH,
    ...placeholder({ title: 'Trash', icon: 'trash' })
  }
]
