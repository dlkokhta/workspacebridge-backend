import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateWhiteboardCommentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  elementId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  body: string;
}
