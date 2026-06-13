import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { randomUUID } from 'crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import { Prisma, User, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LoginAlertService } from './login-alert.service';
import { DEFAULT_SESSION_TTL_MS, REMEMBER_ME_TTL_MS } from './auth.constants';

// The WebAuthn challenge is round-tripped to the browser inside a short-lived,
// signed JWT cookie instead of server-side session storage — stateless, and in
// keeping with this project's "no extra infra (no Redis)" stance.
const CHALLENGE_TTL = '5m';

@Injectable()
export class PasskeyService {
  private readonly logger = new Logger(PasskeyService.name);

  private readonly jwtSecret: string;
  // Refresh tokens use their own secret; falls back to jwtSecret if
  // JWT_REFRESH_SECRET is unset. Mirrors AuthService / TwoFactorAuthService.
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

  /**
   * Relying-party identity. The RP ID (a bare domain) and the expected origin
   * are derived from FRONTEND_URL by default, so passkeys work with no extra
   * configuration; both can still be overridden in production via env
   * (WEBAUTHN_ORIGIN / WEBAUTHN_RP_ID / WEBAUTHN_RP_NAME).
   */
  private rp(): { rpName: string; rpID: string; origin: string } {
    const frontendUrl = this.configService.getOrThrow<string>('FRONTEND_URL');
    const origin = (
      this.configService.get<string>('WEBAUTHN_ORIGIN') || frontendUrl
    ).replace(/\/$/, '');
    const rpID =
      this.configService.get<string>('WEBAUTHN_RP_ID') ||
      new URL(origin).hostname;
    const rpName =
      this.configService.get<string>('WEBAUTHN_RP_NAME') || 'WorkspaceBridge';
    return { rpName, rpID, origin };
  }

  private signChallenge(payload: {
    challenge: string;
    purpose: 'reg' | 'auth';
    userId?: string;
  }): string {
    return this.jwtService.sign(payload, {
      secret: this.jwtSecret,
      expiresIn: CHALLENGE_TTL,
    });
  }

  private readChallenge(
    token: string | undefined,
    purpose: 'reg' | 'auth',
  ): { challenge: string; userId?: string } {
    if (!token) {
      throw new BadRequestException(
        'Passkey challenge missing or expired. Please try again.',
      );
    }
    let payload: { challenge: string; purpose: string; userId?: string };
    try {
      payload = this.jwtService.verify(token, { secret: this.jwtSecret });
    } catch {
      throw new BadRequestException(
        'Passkey challenge expired. Please try again.',
      );
    }
    if (payload.purpose !== purpose) {
      throw new BadRequestException('Invalid passkey challenge');
    }
    return { challenge: payload.challenge, userId: payload.userId };
  }

  // ── Registration (user is already signed in) ───────────────────────────────

  async generateRegistrationOptions(userId: string, email: string) {
    const { rpName, rpID } = this.rp();

    const existing = await this.prismaService.credential.findMany({
      where: { userId },
      select: { credentialId: true, transports: true },
    });

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: email,
      userDisplayName: email,
      // Stable per-user handle so multiple passkeys map to one account on the
      // authenticator.
      userID: new Uint8Array(Buffer.from(userId)),
      attestationType: 'none',
      // Don't let the user enrol the same authenticator twice.
      excludeCredentials: existing.map((c) => ({
        id: c.credentialId,
        transports: c.transports?.split(',') as
          | AuthenticatorTransportFuture[]
          | undefined,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    const challengeToken = this.signChallenge({
      challenge: options.challenge,
      purpose: 'reg',
      userId,
    });

    return { options, challengeToken };
  }

  async verifyRegistration(
    userId: string,
    email: string,
    response: RegistrationResponseJSON,
    challengeToken: string | undefined,
    label: string | undefined,
    ip?: string,
    userAgent?: string,
  ) {
    const { challenge, userId: challengeUserId } = this.readChallenge(
      challengeToken,
      'reg',
    );
    if (challengeUserId !== userId) {
      throw new UnauthorizedException('Passkey challenge does not match');
    }

    const { origin, rpID } = this.rp();

    let verification: VerifiedRegistrationResponse;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        // Security keys may not always verify the user; user presence is enough.
        requireUserVerification: false,
      });
    } catch {
      throw new BadRequestException(
        'Passkey registration could not be verified',
      );
    }

    if (!verification.verified || !verification.registrationInfo) {
      throw new BadRequestException(
        'Passkey registration could not be verified',
      );
    }

    const { credential, credentialDeviceType, credentialBackedUp } =
      verification.registrationInfo;

    const duplicate = await this.prismaService.credential.findUnique({
      where: { credentialId: credential.id },
    });
    if (duplicate) {
      throw new ConflictException('This passkey is already registered');
    }

    const saved = await this.prismaService.credential.create({
      data: {
        userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports?.join(',') ?? null,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        name: label?.trim() || null,
      },
      select: this.passkeySelect,
    });

    this.audit('auth.passkey_registered', userId, { email, ip, userAgent });

    return saved;
  }

  // ── Authentication (anonymous; usernameless / discoverable credentials) ─────

  async generateAuthenticationOptions() {
    const { rpID } = this.rp();

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'preferred',
      // Empty allowCredentials → the browser offers any discoverable passkey for
      // this site, so the user never has to type an email first.
    });

    const challengeToken = this.signChallenge({
      challenge: options.challenge,
      purpose: 'auth',
    });

    return { options, challengeToken };
  }

  async verifyAuthentication(
    response: AuthenticationResponseJSON,
    challengeToken: string | undefined,
    rememberMe: boolean,
    ip?: string,
    userAgent?: string,
  ) {
    const { challenge } = this.readChallenge(challengeToken, 'auth');
    const { origin, rpID } = this.rp();

    const credential = await this.prismaService.credential.findUnique({
      where: { credentialId: response.id },
      include: { user: true },
    });
    if (!credential) {
      throw new UnauthorizedException('Passkey not recognised');
    }

    let verification: VerifiedAuthenticationResponse;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false,
        credential: {
          id: credential.credentialId,
          publicKey: new Uint8Array(
            Buffer.from(credential.publicKey, 'base64url'),
          ),
          counter: credential.counter,
          transports: credential.transports?.split(',') as
            | AuthenticatorTransportFuture[]
            | undefined,
        },
      });
    } catch {
      throw new UnauthorizedException('Passkey verification failed');
    }

    if (!verification.verified) {
      throw new UnauthorizedException('Passkey verification failed');
    }

    if (credential.user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Account is suspended');
    }

    // Persist the new signature counter (clone-detection) and last-used time.
    await this.prismaService.credential.update({
      where: { id: credential.id },
      data: {
        counter: verification.authenticationInfo.newCounter,
        lastUsedAt: new Date(),
      },
    });

    // A verified passkey is possession + (biometric/PIN) — strong enough to be
    // a full sign-in on its own, so we issue a session and skip the 2FA step.
    return this.issueSession(credential.user, rememberMe, ip, userAgent);
  }

  // ── Manage passkeys ─────────────────────────────────────────────────────────

  private readonly passkeySelect = {
    id: true,
    name: true,
    deviceType: true,
    backedUp: true,
    createdAt: true,
    lastUsedAt: true,
  } as const;

  async listPasskeys(userId: string) {
    return this.prismaService.credential.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: this.passkeySelect,
    });
  }

  async removePasskey(
    userId: string,
    id: string,
    ip?: string,
    userAgent?: string,
  ) {
    const credential = await this.prismaService.credential.findUnique({
      where: { id },
    });
    if (!credential || credential.userId !== userId) {
      throw new UnauthorizedException('Passkey not found');
    }
    await this.prismaService.credential.delete({ where: { id } });

    this.audit('auth.passkey_removed', userId, { ip, userAgent });

    return { message: 'Passkey removed' };
  }

  // ── Session issuance (mirrors the email/Google/2FA login paths) ─────────────

  private async issueSession(
    user: User,
    rememberMe: boolean,
    ip?: string,
    userAgent?: string,
  ) {
    const sessionId = randomUUID();
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

    // Cap a user at 10 concurrent sessions, evicting the oldest — same policy
    // the password/2FA login paths enforce.
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

    // A passkey login is the real end of a login — run the new-device alert
    // check and write the success audit row (never throws).
    await this.loginAlertService.handleSuccessfulLogin('auth.passkey_login', {
      userId: user.id,
      email: user.email,
      ip,
      userAgent,
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password, twoFactorSecret, ...userSafe } = user;

    return { user: userSafe, accessToken, refreshToken, rememberMe };
  }

  // Fire-and-forget audit write, same contract as AuthService.auditAuthEvent:
  // an audit failure is logged server-side and dropped, never thrown.
  private audit(
    action: string,
    userId: string,
    metadata: Record<string, unknown>,
  ): void {
    // JSON round-trip strips undefined values, which Prisma's JSON input
    // rejects (ip/userAgent are optional).
    const cleanMetadata = JSON.parse(
      JSON.stringify(metadata),
    ) as Prisma.InputJsonValue;
    void Promise.resolve(
      this.prismaService.auditLog.create({
        data: {
          action,
          targetType: 'user',
          targetId: userId,
          actorId: userId,
          metadata: cleanMetadata,
        },
      }),
    ).catch((err) => this.logger.error('Failed to write auth audit log', err));
  }
}
