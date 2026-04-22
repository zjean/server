import { Routes } from '@angular/router'
import { KitComponent } from './screens/kit/kit.component'
import { StubComponent } from './screens/stub/stub.component'

export const v2Routes: Routes = [
  { path: '', component: StubComponent },
  { path: '_kit', component: KitComponent }
]
