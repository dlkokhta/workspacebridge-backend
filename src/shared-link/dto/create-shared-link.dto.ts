import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateSharedLinkDto {
  @ApiProperty({ example: 'https://figma.com/file/abc123' })
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(2048)
  url!: string;

  @ApiPropertyOptional({ example: 'Homepage mockup' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  title?: string;
}
