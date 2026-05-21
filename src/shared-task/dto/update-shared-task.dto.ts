import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TaskStatus } from '@prisma/client';

export class UpdateSharedTaskDto {
  @ApiPropertyOptional({ example: 'Send updated logo mockups' })
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
