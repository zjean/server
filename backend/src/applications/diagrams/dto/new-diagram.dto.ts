import { IsNotEmpty, IsString } from 'class-validator'

export class NewDiagramDto {
  @IsString()
  @IsNotEmpty()
  dirPath: string

  @IsString()
  @IsNotEmpty()
  name: string
}
