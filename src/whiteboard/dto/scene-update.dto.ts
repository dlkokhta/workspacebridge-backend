import { IsArray, IsObject, IsOptional, IsUUID } from 'class-validator';

export class SceneUpdateDto {
  @IsUUID()
  workspaceId: string;

  @IsArray()
  elements: unknown[];

  @IsObject()
  @IsOptional()
  appState?: Record<string, unknown>;
}
