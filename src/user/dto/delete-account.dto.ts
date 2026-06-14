import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class DeleteAccountDto {
  @ApiPropertyOptional({
    description:
      'Current password. Required for credential accounts to confirm deletion; ignored for OAuth (Google) accounts, which have no password.',
  })
  @IsOptional()
  @IsString({ message: 'Password must be a string' })
  password?: string;
}
