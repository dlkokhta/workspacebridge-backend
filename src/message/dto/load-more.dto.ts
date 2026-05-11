import { IsUUID } from 'class-validator';

export class LoadMoreMessagesDto {
  @IsUUID()
  workspaceId: string;

  @IsUUID()
  cursor: string;
}
