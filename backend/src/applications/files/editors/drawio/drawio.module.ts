import { Module } from '@nestjs/common'
import { DrawioController } from './drawio.controller'
import { DrawioService } from './drawio.service'

@Module({
  controllers: [DrawioController],
  providers: [DrawioService]
})
export class DrawioModule {}
