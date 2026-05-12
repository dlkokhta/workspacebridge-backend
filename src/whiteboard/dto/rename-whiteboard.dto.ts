import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RenameWhiteboardDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;
}
