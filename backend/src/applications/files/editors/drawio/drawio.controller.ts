import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Query } from '@nestjs/common'
import { GetUser } from '../../../users/decorators/user.decorator'
import { UserModel } from '../../../users/models/user.model'
import { DrawioService } from './drawio.service'
import type { LoadDiagramResponse } from './drawio.dtos'
import { NewDiagramDto, SaveDiagramDto } from './drawio.dtos'

@Controller('api/diagrams')
export class DrawioController {
  constructor(private readonly service: DrawioService) {}

  @Get('load')
  load(@GetUser() user: UserModel, @Query('path') path: string): Promise<LoadDiagramResponse> {
    return this.service.load(user, path)
  }

  @Put('save')
  @HttpCode(HttpStatus.OK)
  save(@GetUser() user: UserModel, @Body() dto: SaveDiagramDto): Promise<{ etag: string; mtime: number }> {
    return this.service.save(user, dto)
  }

  @Post('new')
  @HttpCode(HttpStatus.CREATED)
  createNew(@GetUser() user: UserModel, @Body() dto: NewDiagramDto): Promise<{ path: string }> {
    return this.service.createNew(user, dto)
  }
}
