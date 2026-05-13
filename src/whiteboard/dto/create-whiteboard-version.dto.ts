import {
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateWhiteboardVersionDto {
  @IsString()
  @IsOptional()
  @MaxLength(120)
  label?: string;

  @IsArray()
  elements: unknown[];

  @IsObject()
  @IsOptional()
  appState?: Record<string, unknown>;

  @IsObject()
  @IsOptional()
  files?: Record<string, unknown>;
}
