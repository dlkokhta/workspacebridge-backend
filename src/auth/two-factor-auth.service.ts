import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import * as speakeasy from 'speakeasy';
import * as qrcode from 'qrcode';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { JwtPayload } from './types/jwt-payload.type';
import {
  decryptSecret,
  encryptSecret,
} from '../libs/common/utils/secret-crypto';
import { UserStatus } from '@prisma/client';
import { AuditAction } from '../libs/common/audit/audit-actions';
import { writeAuditLog } from '../libs/common/audit/audit-log.util';
import {
  DEFAULT_SESSION_TTL_MS,
  REMEMBER_ME_TTL_MS,
} from './auth.constants';
import { LoginAlertService } from './login-alert.service';

@Injectable()
export class TwoFactorAuthService {
  private readonly logger = new Logger(TwoFactorAuthService.name);

  private static readonly MAX_VERIFY_ATTEMPTS_PER_TOKEN = 5;
  private static readonly BACKUP_CODE_COUNT = 10;
  // Pending 2FA setup expires after this window. The user has to scan the
  // QR code and submit the first TOTP code before it lapses; otherwise
  // they need to start over with a fresh secret. Long enough to find
  // your phone and open the authenticator app, short enough that
  // abandoned setups don't linger.
  private static readonly PENDING_SETUP_TTL_MS = 15 * 60 * 1000; // 15 min

  private readonly jwtSecret: string;
  // Refresh tokens use their own secret; falls back to jwtSecret if
  // JWT_REFRESH_SECRET is unset. See AuthService for full rationale.
  private readonly jwtRefreshSecret: string;
  private readonly accessExpiresIn: string;

  constructor(
    private readonly prismaService: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly loginAlertService: LoginAlertService,
  ) {
    this.jwtSecret = this.configService.getOrThrow<string>('JWT_SECRET');
    this.jwtRefreshSecret =
      this.configService.get<string>('JWT_REFRESH_SECRET') ?? this.jwtSecret;
    this.accessExpiresIn =
      this.configService.get<string>('JWT_ACCESS_EXPIRES_IN') || '15m';
  }

  // ── Backup codes ─────────────────────────────────────────────────────────

  // 10 codes in xxxx-xxxx hex form. Only SHA-256 hashes are stored; the
  // plaintext codes are shown to the user exactly once. SHA-256 (not argon2)
  // is fine here: the input space is 2^32 random values, not a human
  // password, so brute-forcing the hash is already infeasible.
  private generatePlainBackupCodes(): string[] {
    const codes: string[] = [];
    for (let i = 0; i < TwoFactorAuthService.BACKUP_CODE_COUNT; i++) {
      const raw = randomBytes(4).toString('hex');
      codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
    }
    return codes;
  }

  private hashBackupCode(code: string): string {
    return createHash('sha256').update(code.replace('-', '')).digest('hex');
  }

  // Replaces the user's entire code set — old codes (used or not) become
  // invalid the moment a new set is issued.
  private async storeBackupCodes(userId: string, plainCodes: string[]) {
    await this.prismaService.backupCode.deleteMany({ where: { userId } });
    await this.prismaService.backupCode.createMany({
      data: plainCodes.map((code) => ({
        userId,
        code: this.hashBackupCode(code),
      })),
    });
  }

  async regenerateBackupCodes(userId: string, totpCode: string) {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
    });
    if (!user?.isTwoFactorEnabled || !user?.twoFactorSecret) {
      throw new BadRequestException('2FA is not enabled on this account');
    }

    // Re-prove possession of the authenticator before rotating the codes —
    // a hijacked session alone must not be able to mint fresh codes.
    const isValid = speakeasy.totp.verify({
      secret: decryptSecret(user.twoFactorSecret),
      encoding: 'base32',
      token: totpCode,
      window: 1,
    });
    if (!isValid) {
      throw new UnauthorizedException('Invalid authentication code');
    }

    const plainCodes = this.generatePlainBackupCodes();
    await this.storeBackupCodes(userId, plainCodes);

    this.audit('auth.backup_codes_regenerated', userId, {
      email: user.email,
    });

    return { backupCodes: plainCodes };
  }

  // Fire-and-forget audit write; email/ip/userAgent land in dedicated columns.
  private audit(
    action: AuditAction,
    userId: string,
    metadata: Record<string, unknown>,
  ): void {
    writeAuditLog(this.prismaService, this.logger, action, userId, metadata);
  }

  async generateAndStoreSecret(userId: string, email: string) {
    const secret = speakeasy.generateSecret({
      name: `workspacebridge (${email})`,
      issuer: 'workspacebridge',
      length: 20,
    });

    // Stage the unverified secret in PendingTwoFactorSetup rather than
    // touching users.two_factor_secret. The secret is only promoted to
    // the user row once enableTwoFactor verifies the first TOTP code.
    // upsert handles the "user started setup twice" case: the latest
    // attempt always replaces any older pending row.
    const encryptedSecret = encryptSecret(secret.base32);
    const expiresAt = new Date(
      Date.now() + TwoFactorAuthService.PENDING_SETUP_TTL_MS,
    );
    await this.prismaService.pendingTwoFactorSetup.upsert({
      where: { userId },
      update: { secret: encryptedSecret, expiresAt },
      create: { userId, secret: encryptedSecret, expiresAt },
    });

    const qrCodeDataURL = await qrcode.toDataURL(secret.otpauth_url!);

    return { qrCodeDataURL };
  }

  async enableTwoFactor(userId: string, code: string) {
    // Read the unverified secret from the staging table — users.two_factor_secret
    // is only written once we promote here, so abandoned setups leave no
    // trace on the user row.
    const pending =
      await this.prismaService.pendingTwoFactorSetup.findUnique({
        where: { userId },
      });

    if (!pending) {
      throw new BadRequestException(
        'Please generate a QR code first by calling /auth/2fa/generate',
      );
    }

    if (pending.expiresAt < new Date()) {
      await this.prismaService.pendingTwoFactorSetup.delete({
        where: { userId },
      });
      throw new BadRequestException(
        'Setup expired. Please generate a new QR code.',
      );
    }

    const isValid = speakeasy.totp.verify({
      secret: decryptSecret(pending.secret),
      encoding: 'base32',
      token: code,
      window: 1,
    });

    if (!isValid) {
      throw new UnauthorizedException('Invalid authentication code');
    }

    // Promote the verified secret to the user row and clear the staging
    // entry. From this point onwards login/disable flows read from
    // users.two_factor_secret as before.
    await this.prismaService.$transaction([
      this.prismaService.user.update({
        where: { id: userId },
        data: {
          isTwoFactorEnabled: true,
          twoFactorSecret: pending.secret,
        },
      }),
      this.prismaService.pendingTwoFactorSetup.delete({
        where: { userId },
      }),
    ]);

    // Issue the recovery codes alongside enablement — this response is the
    // only time the plaintext codes ever leave the server.
    const backupCodes = this.generatePlainBackupCodes();
    await this.storeBackupCodes(userId, backupCodes);

    return { message: '2FA enabled successfully', backupCodes };
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

    // Recovery codes are only meaningful while 2FA is on.
    await this.prismaService.backupCode.deleteMany({ where: { userId } });

    return { message: '2FA disabled successfully' };
  }

  async verifyTwoFactorForLogin(
    tempToken: string,
    code: string | undefined,
    ip?: string,
    userAgent?: string,
    backupCode?: string,
  ) {
    if (!code && !backupCode) {
      throw new BadRequestException(
        'Provide either a TOTP code or a backup code',
      );
    }

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

    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Account is suspended');
    }

    if (!user.isTwoFactorEnabled || !user.twoFactorSecret) {
      throw new BadRequestException('2FA is not configured for this account');
    }

    if (backupCode) {
      // One-time recovery code path. Shares the per-token attempt
      // accounting with TOTP, so code guessing burns the tempToken just
      // as fast either way.
      const stored = await this.prismaService.backupCode.findFirst({
        where: {
          userId: user.id,
          code: this.hashBackupCode(backupCode),
          usedAt: null,
        },
      });
      if (!stored) {
        await this.registerFailedVerifyAttempt(payload.jti, attempt.attempts);
        throw new UnauthorizedException('Invalid or already used backup code');
      }
      await this.prismaService.backupCode.update({
        where: { id: stored.id },
        data: { usedAt: new Date() },
      });
      this.audit('auth.backup_code_used', user.id, {
        email: user.email,
        ip,
        userAgent,
      });
    } else {
      const isValid = speakeasy.totp.verify({
        secret: decryptSecret(user.twoFactorSecret),
        encoding: 'base32',
        token: code!,
        window: 1,
      });

      if (!isValid) {
        await this.registerFailedVerifyAttempt(payload.jti, attempt.attempts);
        throw new UnauthorizedException('Invalid authentication code');
      }
    }

    // Successful verify — burn the token so it can never be replayed.
    await this.prismaService.twoFactorAttempt.update({
      where: { jti: payload.jti },
      data: { consumed: true },
    });

    const sessionId = randomUUID();
    // The rememberMe choice was made at the password step and rides in the
    // tempToken payload — honor it when issuing the real session.
    const rememberMe = !!payload.rememberMe;
    const ttlMs = rememberMe ? REMEMBER_ME_TTL_MS : DEFAULT_SESSION_TTL_MS;
    const accessPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
    };
    const refreshPayload = { ...accessPayload, sessionId, rememberMe };

    const accessToken = this.jwtService.sign(accessPayload, {
      secret: this.jwtSecret,
      expiresIn: this.accessExpiresIn,
    });

    const refreshToken = this.jwtService.sign(refreshPayload, {
      secret: this.jwtRefreshSecret,
      expiresIn: Math.floor(ttlMs / 1000),
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
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });

    // 2FA completion is the real end of a login — the password step never
    // fires the alert, so it lands here exactly once per login.
    await this.loginAlertService.handleSuccessfulLogin('auth.2fa_login', {
      userId: user.id,
      email: user.email,
      ip,
      userAgent,
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password, twoFactorSecret, ...userSafe } = user;

    return { user: userSafe, accessToken, refreshToken, rememberMe };
  }

  // Count a failed verify against this tempToken. Burn the token
  // (consumed=true) once we hit the cap so further guesses against this
  // same tempToken are rejected even if the JWT itself hasn't expired yet.
  private async registerFailedVerifyAttempt(
    jti: string,
    priorAttempts: number,
  ) {
    const nextAttempts = priorAttempts + 1;
    const shouldBurn =
      nextAttempts >= TwoFactorAuthService.MAX_VERIFY_ATTEMPTS_PER_TOKEN;
    await this.prismaService.twoFactorAttempt.update({
      where: { jti },
      data: { attempts: nextAttempts, consumed: shouldBurn },
    });
  }
}
