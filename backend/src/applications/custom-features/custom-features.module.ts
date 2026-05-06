import { Module } from '@nestjs/common'
import { CustomDiagramsModule } from '../custom-diagrams/custom-diagrams.module'

@Module({
  imports: [CustomDiagramsModule]
})
export class CustomFeaturesModule {}
