import { IsInt, IsString } from 'class-validator'

export class SaveDiagramDto {
  @IsInt()
  fileId: number

  @IsString()
  xml: string

  @IsString()
  etag: string
}
