import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';
import { CSRF_COOKIE } from '../auth.constants';

/**
 * Double-submit cookie CSRF protection for endpoints that authenticate via
 * the automatically-sent refresh cookie (refresh, logout). Requires an
 * X-CSRF-Token header that matches the non-httpOnly csrfToken cookie — a
 * value a cross-site attacker can neither read nor set.
 *
 * Bearer-token endpoints don't need this: a forged cross-site request can't
 * set the Authorization header in the first place.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    const cookieToken: string | undefined = req.cookies?.[CSRF_COOKIE];
    const headerValue = req.headers['x-csrf-token'];
    const headerToken = Array.isArray(headerValue)
      ? headerValue[0]
      : headerValue;

    if (
      !cookieToken ||
      !headerToken ||
      !this.safeEqual(cookieToken, headerToken)
    ) {
      throw new ForbiddenException('Invalid or missing CSRF token');
    }
    return true;
  }

  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
