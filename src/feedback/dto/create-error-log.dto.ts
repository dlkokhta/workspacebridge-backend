import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const ERROR_SOURCES = [
  'window.onerror',
  'unhandledrejection',
  'react-error-boundary',
] as const;

export class CreateErrorLogDto {
  @ApiProperty({
    example: "Cannot read properties of undefined (reading 'id')",
  })
  @IsString()
  @MaxLength(2000)
  message!: string;

  @ApiProperty({ enum: ERROR_SOURCES, example: 'window.onerror' })
  @IsIn(ERROR_SOURCES)
  source!: (typeof ERROR_SOURCES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  stack?: string;

  @ApiPropertyOptional({ example: '/workspace/abc123?tab=whiteboard' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  url?: string;

  @ApiPropertyOptional({
    description: 'React component stack (boundary only).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  componentStack?: string;
}
