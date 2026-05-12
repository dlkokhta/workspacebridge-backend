import { IsUUID } from 'class-validator';

export class JoinBoardDto {
  @IsUUID()
  boardId: string;
}
