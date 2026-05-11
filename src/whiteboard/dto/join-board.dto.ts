import { IsUUID } from 'class-validator';

export class JoinBoardDto {
  @IsUUID()
  workspaceId: string;
}
