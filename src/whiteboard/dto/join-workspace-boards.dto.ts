import { IsUUID } from 'class-validator';

export class JoinWorkspaceBoardsDto {
  @IsUUID()
  workspaceId: string;
}
