import { IsUUID } from 'class-validator';

export class JoinSharedLinkRoomDto {
  @IsUUID()
  workspaceId: string;
}
