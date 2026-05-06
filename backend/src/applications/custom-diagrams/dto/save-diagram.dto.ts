import { IsString } from 'class-validator'

export class SaveDiagramDto {
  @IsString()
  path: string

  @IsString()
  xml: string

  @IsString()
  etag: string
}
