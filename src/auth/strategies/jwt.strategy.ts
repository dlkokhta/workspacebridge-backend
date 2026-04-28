import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UserService } from 'src/user/user.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly userService: UserService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'your_default_jwt_secret',
    });
  }

  async validate(payload: any) {
    // 1. Check that the payload exists
    if (!payload) {
      throw new UnauthorizedException('Invalid token');
    }

    // 2. Verify that the user still exists in the database
    const user = await this.userService.findById(payload.userId);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // 3. Return the user object (this will become req.user)
    return user;
  }
}
