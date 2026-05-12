import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateWhiteboardDto {
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  @MaxLength(100)
  name?: string;
}
