import { IsNotEmpty, IsString } from 'class-validator'

export class SaveDiagramDto {
  @IsString()
  @IsNotEmpty()
  path: string

  @IsString()
  @IsNotEmpty()
  xml: string

  @IsString()
  @IsNotEmpty()
  etag: string
}
