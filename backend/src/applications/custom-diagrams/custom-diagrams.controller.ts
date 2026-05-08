import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Query } from '@nestjs/common'
import { GetUser } from '../users/decorators/user.decorator'
import { UserModel } from '../users/models/user.model'
import { CustomDiagramsService } from './custom-diagrams.service'
import type { LoadDiagramResponse } from './dto/load-diagram-response.dto'
import { NewDiagramDto } from './dto/new-diagram.dto'
import { SaveDiagramDto } from './dto/save-diagram.dto'

@Controller('api/diagrams')
export class CustomDiagramsController {
  constructor(private readonly service: CustomDiagramsService) {}

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
