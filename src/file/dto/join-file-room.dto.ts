import { IsUUID } from 'class-validator';

export class JoinFileRoomDto {
  @IsUUID()
  workspaceId: string;
}
