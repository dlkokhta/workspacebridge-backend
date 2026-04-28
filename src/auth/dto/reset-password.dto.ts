import {
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
  IsStrongPassword,
  Validate,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { IsPasswordsMatchingConstraint } from '../../libs/common/validators/is-passwords-matching';

export class ResetPasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'Token is required' })
  token: string;

  @ApiProperty({ example: 'NewP@ssw0rd!', minLength: 8, maxLength: 128 })
  @IsString()
  @IsNotEmpty({ message: 'Password is required' })
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  @MaxLength(128, { message: 'Password cannot exceed 128 characters' })
  @IsStrongPassword(
    { minLength: 8, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 1 },
    {
      message:
        'Password must contain at least 8 characters with uppercase, lowercase, number, and special character',
    },
  )
  password: string;

  @ApiProperty({ example: 'NewP@ssw0rd!', minLength: 8, maxLength: 128 })
  @IsString()
  @IsNotEmpty({ message: 'Password confirmation is required' })
  @MinLength(8)
  @MaxLength(128)
  @IsStrongPassword({ minLength: 8, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 1 })
  @Validate(IsPasswordsMatchingConstraint)
  passwordRepeat: string;
}
