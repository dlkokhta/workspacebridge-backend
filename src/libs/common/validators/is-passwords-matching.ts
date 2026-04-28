import {
  ValidatorConstraint,
  ValidationArguments,
  ValidatorConstraintInterface,
} from 'class-validator';

import { CreateUserDto } from '../../../auth/dto/create-user.dto';

@ValidatorConstraint({ name: 'IsPasswordsMatching', async: false })
export class IsPasswordsMatchingConstraint
  implements ValidatorConstraintInterface
{
  public validate(passwordRepeat: string, args: ValidationArguments) {
    const obj = args.object as CreateUserDto;
    return obj.password === passwordRepeat;
  }

  public defaultMessage(ValidationArguments?: ValidationArguments) {
    return 'Passwords do not match';
  }
}
