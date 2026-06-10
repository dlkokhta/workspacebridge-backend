import { UserRole } from '@prisma/client';

export interface JwtPayload {
  userId: string;
  email: string;
  role: UserRole;
  sessionId?: string;
  // "Remember me" choice — rides in refresh tokens and 2FA tempTokens so the
  // 30-day vs 1-day session lifetime survives rotation and the 2FA step.
  rememberMe?: boolean;
  isTwoFactorAuthenticated?: boolean;
  // JWT ID — set on 2FA pre-auth tempTokens so we can track replay /
  // brute-force attempts per token in the TwoFactorAttempt table.
  jti?: string;
  iat?: number;
  exp?: number;
}
