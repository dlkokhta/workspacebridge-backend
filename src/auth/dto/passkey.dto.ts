import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server';

export class VerifyPasskeyRegistrationDto {
  @ApiProperty({
    description: 'The registration response from the browser authenticator',
  })
  @IsObject()
  response: RegistrationResponseJSON;

  @ApiPropertyOptional({
    description: 'Optional user-facing label for the passkey',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;
}

export class VerifyPasskeyAuthenticationDto {
  @ApiProperty({
    description: 'The authentication response from the browser authenticator',
  })
  @IsObject()
  response: AuthenticationResponseJSON;

  @ApiPropertyOptional({ description: 'Keep me signed in for 30 days' })
  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}
