import { IsNotEmpty, IsString } from 'class-validator'

export class NewDiagramDto {
  @IsString()
  @IsNotEmpty()
  dirPath: string // e.g. 'files/personal' or 'files/personal/Documents'

  @IsString()
  @IsNotEmpty()
  name: string // e.g. 'Untitled diagram.drawio'
}
