import { Component, inject } from '@angular/core'
import { Router } from '@angular/router'
import { L10nTranslateDirective } from 'angular-l10n'
import { clearUiVersion } from '../../ui-version'

@Component({
  selector: 'app-v2-stub',
  templateUrl: './stub.component.html',
  styleUrl: './stub.component.scss',
  imports: [L10nTranslateDirective]
})
export class StubComponent {
  private readonly router = inject(Router)

  backToClassic() {
    clearUiVersion()
    this.router.navigate(['/']).catch(console.error)
  }
}
