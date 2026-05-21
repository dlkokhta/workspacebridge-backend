import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateSharedTaskDto {
  @ApiProperty({ example: 'Send updated logo mockups' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;
}
