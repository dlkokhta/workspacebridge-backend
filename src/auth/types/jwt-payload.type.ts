import { UserRole } from '@prisma/client';

export interface JwtPayload {
  userId: string;
  email: string;
  role: UserRole;
  sessionId?: string;
  isTwoFactorAuthenticated?: boolean;
  iat?: number;
  exp?: number;
}
