import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import * as speakeasy from 'speakeasy';
import * as qrcode from 'qrcode';
import * as argon2 from 'argon2';
import { randomUUID } from 'crypto';
import { JwtPayload } from './types/jwt-payload.type';
import {
  decryptSecret,
  encryptSecret,
} from '../libs/common/utils/secret-crypto';

@Injectable()
export class TwoFactorAuthService {
  private static readonly MAX_VERIFY_ATTEMPTS_PER_TOKEN = 5;

  private readonly jwtSecret: string;
  // Refresh tokens use their own secret; falls back to jwtSecret if
  // JWT_REFRESH_SECRET is unset. See AuthService for full rationale.
  private readonly jwtRefreshSecret: string;
  private readonly accessExpiresIn: string;
  private readonly refreshExpiresIn: string;

  constructor(
    private readonly prismaService: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.jwtSecret = this.configService.getOrThrow<string>('JWT_SECRET');
    this.jwtRefreshSecret =
      this.configService.get<string>('JWT_REFRESH_SECRET') ?? this.jwtSecret;
    this.accessExpiresIn =
      this.configService.get<string>('JWT_ACCESS_EXPIRES_IN') || '15m';
    this.refreshExpiresIn =
      this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') || '7d';
  }

  async generateAndStoreSecret(userId: string, email: string) {
    const secret = speakeasy.generateSecret({
      name: `workspacebridge (${email})`,
      issuer: 'workspacebridge',
      length: 20,
    });

    // Encrypt at rest. A DB dump no longer hands every user's 2FA seed
    // to the attacker; they'd also need ENCRYPTION_KEY.
    await this.prismaService.user.update({
      where: { id: userId },
      data: { twoFactorSecret: encryptSecret(secret.base32) },
    });

    const qrCodeDataURL = await qrcode.toDataURL(secret.otpauth_url!);

    return { qrCodeDataURL };
  }

  async enableTwoFactor(userId: string, code: string) {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
    });

    if (!user?.twoFactorSecret) {
      throw new BadRequestException(
        'Please generate a QR code first by calling /auth/2fa/generate',
      );
    }

    const isValid = speakeasy.totp.verify({
      secret: decryptSecret(user.twoFactorSecret),
      encoding: 'base32',
      token: code,
      window: 1,
    });

    if (!isValid) {
      throw new UnauthorizedException('Invalid authentication code');
    }

    await this.prismaService.user.update({
      where: { id: userId },
      data: { isTwoFactorEnabled: true },
    });

    return { message: '2FA enabled successfully' };
  }

  async disableTwoFactor(userId: string, code: string, password: string) {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
    });

    if (!user?.isTwoFactorEnabled || !user?.twoFactorSecret) {
      throw new BadRequestException('2FA is not enabled on this account');
    }

    // Disabling 2FA is a sensitive action — require fresh password
    // re-authentication so a hijacked session plus access to the
    // authenticator app alone is not enough. Google-only users have no
    // password to verify here; they'd need account recovery instead.
    if (!user.password) {
      throw new BadRequestException(
        'This account has no password set. Use account recovery to disable 2FA.',
      );
    }

    const isPasswordValid = await argon2.verify(user.password, password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid password');
    }

    const isValid = speakeasy.totp.verify({
      secret: decryptSecret(user.twoFactorSecret),
      encoding: 'base32',
      token: code,
      window: 1,
    });

    if (!isValid) {
      throw new UnauthorizedException('Invalid authentication code');
    }

    await this.prismaService.user.update({
      where: { id: userId },
      data: { isTwoFactorEnabled: false, twoFactorSecret: null },
    });

    return { message: '2FA disabled successfully' };
  }

  async verifyTwoFactorForLogin(
    tempToken: string,
    code: string,
    ip?: string,
    userAgent?: string,
  ) {
    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify<JwtPayload>(tempToken, {
        secret: this.jwtSecret,
      });
    } catch {
      throw new UnauthorizedException(
        'Invalid or expired session. Please log in again.',
      );
    }

    if (payload.isTwoFactorAuthenticated !== false || !payload.jti) {
      throw new UnauthorizedException('Invalid token type');
    }

    // Look up the tracking row for this tempToken. Reject if the token was
    // already consumed (replay), burned by too many failed guesses, or the
    // record has expired. This is the per-token defense that the per-IP
    // throttler can't provide against distributed attacks.
    const attempt = await this.prismaService.twoFactorAttempt.findUnique({
      where: { jti: payload.jti },
    });
    if (!attempt || attempt.consumed || attempt.expiresAt < new Date()) {
      throw new UnauthorizedException(
        'Invalid or expired session. Please log in again.',
      );
    }

    const user = await this.prismaService.user.findUnique({
      where: { id: payload.userId },
    });

    if (!user?.isTwoFactorEnabled || !user?.twoFactorSecret) {
      throw new BadRequestException('2FA is not configured for this account');
    }

    const isValid = speakeasy.totp.verify({
      secret: decryptSecret(user.twoFactorSecret),
      encoding: 'base32',
      token: code,
      window: 1,
    });

    if (!isValid) {
      // Count the failed attempt. Burn the token (consumed=true) once we
      // hit the cap so further guesses against this same tempToken are
      // rejected even if the JWT itself hasn't expired yet.
      const nextAttempts = attempt.attempts + 1;
      const shouldBurn =
        nextAttempts >= TwoFactorAuthService.MAX_VERIFY_ATTEMPTS_PER_TOKEN;
      await this.prismaService.twoFactorAttempt.update({
        where: { jti: payload.jti },
        data: { attempts: nextAttempts, consumed: shouldBurn },
      });
      throw new UnauthorizedException('Invalid authentication code');
    }

    // Successful verify — burn the token so it can never be replayed.
    await this.prismaService.twoFactorAttempt.update({
      where: { jti: payload.jti },
      data: { consumed: true },
    });

    const sessionId = randomUUID();
    const accessPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
    };
    const refreshPayload = { ...accessPayload, sessionId };

    const accessToken = this.jwtService.sign(accessPayload, {
      secret: this.jwtSecret,
      expiresIn: this.accessExpiresIn,
    });

    const refreshToken = this.jwtService.sign(refreshPayload, {
      secret: this.jwtRefreshSecret,
      expiresIn: this.refreshExpiresIn,
    });

    const hashedRefreshToken = await argon2.hash(refreshToken);

    const existingSessions = await this.prismaService.session.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (existingSessions.length >= 10) {
      const toDelete = existingSessions.slice(0, existingSessions.length - 9);
      await this.prismaService.session.deleteMany({
        where: { id: { in: toDelete.map((s) => s.id) } },
      });
    }

    await this.prismaService.session.create({
      data: {
        id: sessionId,
        userId: user.id,
        refreshToken: hashedRefreshToken,
        ip,
        userAgent,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password, twoFactorSecret, ...userSafe } = user;

    return { user: userSafe, accessToken, refreshToken };
  }
}
