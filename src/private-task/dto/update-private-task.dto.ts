import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TaskStatus } from '@prisma/client';

export class UpdatePrivateTaskDto {
  @ApiPropertyOptional({ example: 'Draft invoice for this client' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ enum: TaskStatus, example: TaskStatus.DONE })
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;
}
