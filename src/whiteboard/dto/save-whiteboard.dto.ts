import { IsArray, IsObject, IsOptional } from 'class-validator';

export class SaveWhiteboardDto {
  @IsArray()
  elements: unknown[];

  @IsObject()
  @IsOptional()
  appState?: Record<string, unknown>;

  @IsObject()
  @IsOptional()
  files?: Record<string, unknown>;
}
