import { Component, HostBinding, OnInit, ViewEncapsulation } from '@angular/core'
import { RouterOutlet } from '@angular/router'
import { setUiVersion } from '../ui-version'

@Component({
  selector: 'app-layout-v2',
  templateUrl: './layout-v2.component.html',
  styleUrl: '../styles/v2.scss',
  encapsulation: ViewEncapsulation.None,
  imports: [RouterOutlet]
})
export class LayoutV2Component implements OnInit {
  @HostBinding('class.v2-root') readonly v2Root = true

  ngOnInit() {
    setUiVersion('v2')
  }
}
