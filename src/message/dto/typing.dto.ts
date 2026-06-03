import { IsBoolean, IsUUID } from 'class-validator';

export class TypingDto {
  @IsUUID()
  workspaceId: string;

  @IsBoolean()
  isTyping: boolean;
}
