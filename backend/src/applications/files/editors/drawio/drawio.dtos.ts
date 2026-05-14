import { IsNotEmpty, IsString } from 'class-validator'

export interface LoadDiagramResponse {
  xml: string
  etag: string
  mtime: number
  name: string
  isWritable: boolean
  editorUrl: string
}

export class NewDiagramDto {
  @IsString()
  @IsNotEmpty()
  dirPath: string

  @IsString()
  @IsNotEmpty()
  name: string
}

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
