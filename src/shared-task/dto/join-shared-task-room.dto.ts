import { IsUUID } from 'class-validator';

export class JoinSharedTaskRoomDto {
  @IsUUID()
  workspaceId: string;
}
