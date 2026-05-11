import { IsUUID } from 'class-validator';

export class JoinRoomDto {
  @IsUUID()
  workspaceId: string;
}
