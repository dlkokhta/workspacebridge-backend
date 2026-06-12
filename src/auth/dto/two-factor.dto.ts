import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length, ValidateIf } from 'class-validator';

export class TwoFactorCodeDto {
  @ApiProperty({ example: '123456', description: '6-digit TOTP code from authenticator app' })
  @IsString()
  @Length(6, 6, { message: 'Code must be exactly 6 digits' })
  code: string;
}

// Disabling 2FA requires the user to re-prove they hold the password,
// not just possession of a logged-in session + TOTP. Without this an
// attacker who hijacks a session can strip the second factor.
export class DisableTwoFactorDto {
  @ApiProperty({ example: '123456', description: '6-digit TOTP code from authenticator app' })
  @IsString()
  @Length(6, 6, { message: 'Code must be exactly 6 digits' })
  code: string;

  @ApiProperty({ description: 'Account password for re-authentication' })
  @IsString()
  @IsNotEmpty({ message: 'Password is required to disable 2FA' })
  password: string;
}

export class VerifyTwoFactorLoginDto {
  @ApiProperty({ description: 'Temporary pre-auth token returned when 2FA is required' })
  @IsString()
  tempToken: string;

  // Exactly one of code / backupCode is expected; each is validated only
  // when the other is absent so the error messages stay specific.
  @ApiPropertyOptional({ example: '123456', description: '6-digit TOTP code from authenticator app' })
  @ValidateIf((o: VerifyTwoFactorLoginDto) => !o.backupCode)
  @IsString()
  @Length(6, 6, { message: 'Code must be exactly 6 digits' })
  code?: string;

  @ApiPropertyOptional({ example: 'a1b2-c3d4', description: 'One-time backup recovery code' })
  @ValidateIf((o: VerifyTwoFactorLoginDto) => !o.code)
  @IsString()
  @IsNotEmpty({ message: 'Backup code must not be empty' })
  backupCode?: string;
}
