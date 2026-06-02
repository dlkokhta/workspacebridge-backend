import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { SEARCH_RESULT_TYPES, SearchResultType } from '../search.service';

export class SearchQueryDto {
  @ApiPropertyOptional({
    description: 'Search terms. Parsed as a web search (quotes, OR, -exclude).',
    example: 'logo feedback',
  })
  @IsString()
  @Transform(({ value }: { value: string }) => value?.trim())
  @MinLength(2)
  @MaxLength(100)
  q!: string;

  @ApiPropertyOptional({
    description: 'Comma-separated result types to include. Defaults to all.',
    enum: SEARCH_RESULT_TYPES,
    isArray: true,
    example: 'message,file',
  })
  @IsOptional()
  @Transform(({ value }: { value: string | string[] }) =>
    Array.isArray(value)
      ? value
      : value
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean),
  )
  @IsEnum(SEARCH_RESULT_TYPES, { each: true })
  types?: SearchResultType[];

  @ApiPropertyOptional({
    description: 'Maximum number of results (1-50).',
    default: 20,
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
