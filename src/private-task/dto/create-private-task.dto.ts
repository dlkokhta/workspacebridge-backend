import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreatePrivateTaskDto {
  @ApiProperty({ example: 'Draft invoice for this client' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;
}
