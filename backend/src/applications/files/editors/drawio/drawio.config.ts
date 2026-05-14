import { IsNotEmpty, IsString } from 'class-validator'

export class DrawioConfig {
  @IsString()
  @IsNotEmpty()
  url: string = 'https://embed.diagrams.net'
}
