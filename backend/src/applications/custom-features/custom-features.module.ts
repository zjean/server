import { Module } from '@nestjs/common'
import { CustomDiagramsModule } from '../custom-diagrams/custom-diagrams.module'
import { CustomRecentsTouchModule } from '../custom-recents-touch/custom-recents-touch.module'

@Module({
  imports: [CustomDiagramsModule, CustomRecentsTouchModule]
})
export class CustomFeaturesModule {}
