import { Module } from '@nestjs/common'
import { OnlyOfficeManager } from './only-office-manager.service'
import { OnlyOfficeController } from './only-office.controller'
import { OnlyOfficeGuard } from './only-office.guard'
import { OnlyOfficeStrategy } from './only-office.strategy'

@Module({
  controllers: [OnlyOfficeController],
  providers: [OnlyOfficeManager, OnlyOfficeGuard, OnlyOfficeStrategy],
  // Exported so the custom-mobile-compat NC OnlyOffice connector can DI the
  // manager (for /config + /track dispatch) and the guard (token-from-query
  // auth on the /track callback endpoint). See
  // docs/plans/2026-04-29-nc-onlyoffice-connector.md.
  exports: [OnlyOfficeManager, OnlyOfficeGuard]
})
export class OnlyOfficeModule {}
