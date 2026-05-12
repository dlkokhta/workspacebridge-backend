import {
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

class Pointer {
  @IsNumber()
  x: number;

  @IsNumber()
  y: number;
}

export class PointerUpdateDto {
  @IsUUID()
  boardId: string;

  @IsObject()
  pointer: Pointer;

  @IsString()
  @IsOptional()
  button?: 'down' | 'up';
}
