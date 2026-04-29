import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class AcceptInviteDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  password: string;
}
