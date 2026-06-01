import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateFileCommentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  body: string;
}
