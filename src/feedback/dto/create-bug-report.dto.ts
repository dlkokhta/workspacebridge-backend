import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BugSeverity } from '@prisma/client';

export class CreateBugReportDto {
  @ApiProperty({ example: 'The Files tab shows a blank screen after upload.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  description!: string;

  @ApiPropertyOptional({ enum: BugSeverity, example: BugSeverity.MEDIUM })
  @IsOptional()
  @IsEnum(BugSeverity)
  severity?: BugSeverity;

  @ApiPropertyOptional({ example: '/workspace/abc123?tab=files' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  url?: string;

  @ApiPropertyOptional({
    description: 'Most recent captured client error, for context.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  lastError?: string;
}
