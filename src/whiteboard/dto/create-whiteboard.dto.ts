import {
  IsArray,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateWhiteboardDto {
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  @MaxLength(100)
  name?: string;

  @IsArray()
  @IsOptional()
  elements?: unknown[];

  @IsObject()
  @IsOptional()
  appState?: Record<string, unknown>;
}
