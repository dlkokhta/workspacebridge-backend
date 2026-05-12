import { IsArray, IsObject, IsOptional, IsUUID } from 'class-validator';

export class SceneUpdateDto {
  @IsUUID()
  boardId: string;

  @IsArray()
  elements: unknown[];

  @IsObject()
  @IsOptional()
  appState?: Record<string, unknown>;

  @IsObject()
  @IsOptional()
  files?: Record<string, unknown>;
}
