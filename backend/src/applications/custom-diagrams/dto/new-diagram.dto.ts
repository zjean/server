import { IsString } from 'class-validator'

export class NewDiagramDto {
  @IsString()
  dirPath: string  // e.g. 'files/personal' or 'files/personal/Documents'

  @IsString()
  name: string     // e.g. 'Untitled diagram.drawio'
}
