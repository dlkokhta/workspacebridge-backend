import { IsEnum, IsHexColor, IsOptional, IsString, MaxLength } from 'class-validator';
import { WorkspaceStatus } from '@prisma/client';

export class UpdateWorkspaceDto {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(300)
  description?: string;

  @IsHexColor()
  @IsOptional()
  color?: string;

  @IsEnum(WorkspaceStatus)
  @IsOptional()
  status?: WorkspaceStatus;
}
