import { UserRole } from '@prisma/client';

export interface JwtPayload {
  userId: string;
  email: string;
  role: UserRole;
  sessionId?: string;
  isTwoFactorAuthenticated?: boolean;
  // JWT ID — set on 2FA pre-auth tempTokens so we can track replay /
  // brute-force attempts per token in the TwoFactorAttempt table.
  jti?: string;
  iat?: number;
  exp?: number;
}
