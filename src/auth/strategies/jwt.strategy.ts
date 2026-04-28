import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UserService } from 'src/user/user.service';
import { JwtPayload } from '../types/jwt-payload.type';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly userService: UserService,
    configService: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload) {
    // 1. Check that the payload exists
    if (!payload) {
      throw new UnauthorizedException('Invalid token');
    }

    // 2. Reject 2FA pre-auth tokens — they may only be used at /auth/2fa/verify
    if (payload.isTwoFactorAuthenticated === false) {
      throw new UnauthorizedException('Invalid token');
    }

    // 3. Verify that the user still exists in the database
    const user = await this.userService.findById(payload.userId);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // 4. Return the user object (this will become req.user)
    return user;
  }
}
