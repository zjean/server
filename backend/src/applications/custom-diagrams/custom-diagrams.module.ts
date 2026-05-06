import { Module } from '@nestjs/common'
import { CustomDiagramsController } from './custom-diagrams.controller'
import { CustomDiagramsService } from './custom-diagrams.service'

@Module({
  controllers: [CustomDiagramsController],
  providers: [CustomDiagramsService]
})
export class CustomDiagramsModule {}
