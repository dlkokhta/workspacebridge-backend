import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UserService } from '../user/user.service';
import { LoginUserDto } from './dto/login.dto';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import * as argon2 from 'argon2';
import { GoogleLoginDto } from './dto/google-login.dto';
import { MailService } from '../mail/mail.service';
import { createHash, randomUUID } from 'crypto';
import { JwtPayload } from './types/jwt-payload.type';
import { GoogleUser } from './types/google-user.type';
import { Prisma, UserStatus } from '@prisma/client';
import {
  DEFAULT_SESSION_TTL_MS,
  REMEMBER_ME_TTL_MS,
} from './auth.constants';
import { PasswordBreachService } from '../libs/common/services/password-breach.service';
import { PasswordHistoryService } from '../libs/common/services/password-history.service';
import { LoginAlertService } from './login-alert.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly jwtSecret: string;
  // Separate secret for refresh tokens. If one secret leaks, the other
  // token type can't be forged. Falls back to jwtSecret when
  // JWT_REFRESH_SECRET is unset so existing deployments keep working —
  // production should set a distinct value.
  private readonly jwtRefreshSecret: string;
  private readonly accessExpiresIn: string;

  // Precomputed argon2 hash used as a constant-time dummy during failed
  // logins. Verifying against this takes the same time as a real
  // verification, so attackers can't tell from response timing whether
  // an email is registered. Lazily initialized on first use.
  private dummyHashPromise: Promise<string> | null = null;

  private getDummyHash(): Promise<string> {
    if (!this.dummyHashPromise) {
      this.dummyHashPromise = argon2.hash(`dummy-${randomUUID()}`);
    }
    return this.dummyHashPromise;
  }

  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly prismaService: PrismaService,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
    private readonly passwordBreachService: PasswordBreachService,
    private readonly passwordHistoryService: PasswordHistoryService,
    private readonly loginAlertService: LoginAlertService,
  ) {
    this.jwtSecret = this.configService.getOrThrow<string>('JWT_SECRET');
    this.jwtRefreshSecret =
      this.configService.get<string>('JWT_REFRESH_SECRET') ?? this.jwtSecret;
    if (this.jwtRefreshSecret === this.jwtSecret) {
      this.logger.warn(
        'JWT_REFRESH_SECRET is not set — using JWT_SECRET for refresh tokens. ' +
          'Set a distinct value in production for defense in depth.',
      );
    }
    this.accessExpiresIn =
      this.configService.get<string>('JWT_ACCESS_EXPIRES_IN') || '15m';
  }

  // Refresh-token/session lifetime: 30 days with "remember me", 1 day
  // otherwise (the old fixed JWT_REFRESH_EXPIRES_IN=7d is no longer used).
  private sessionTtlMs(rememberMe?: boolean): number {
    return rememberMe ? REMEMBER_ME_TTL_MS : DEFAULT_SESSION_TTL_MS;
  }

  // Fails open inside PasswordBreachService — an HIBP outage never blocks a
  // legitimate signup or reset, it only skips the check.
  private async assertPasswordNotBreached(password: string): Promise<void> {
    if (await this.passwordBreachService.isBreached(password)) {
      throw new BadRequestException(
        'This password has appeared in a known data breach. Please choose a different one.',
      );
    }
  }

  private static readonly MAX_FAILED_LOGIN_ATTEMPTS = 5;
  private static readonly LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
  private static readonly MAX_SESSIONS_PER_USER = 10;
  private static readonly REFRESH_GRACE_PERIOD_MS = 30 * 1000; // 30 seconds

  private async enforceSessionLimit(userId: string) {
    const sessions = await this.prismaService.session.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    if (sessions.length >= AuthService.MAX_SESSIONS_PER_USER) {
      const toDelete = sessions.slice(
        0,
        sessions.length - AuthService.MAX_SESSIONS_PER_USER + 1,
      );
      await this.prismaService.session.deleteMany({
        where: { id: { in: toDelete.map((s) => s.id) } },
      });
    }
  }

  // Atomic increment + conditional lock. The previous read-modify-write
  // pattern (read currentAttempts, write currentAttempts + 1) raced under
  // concurrent failed logins for the same user — both requests could read
  // 3, then both write 4, undercounting toward the lockout threshold.
  // Using Prisma's `{ increment: 1 }` pushes the increment to SQL where
  // it's atomic; the returned row tells us the real post-increment count
  // and we apply the lock in a second update if needed.
  private async registerFailedLogin(
    userId: string,
  ): Promise<{ attempts: number; locked: boolean }> {
    const updated = await this.prismaService.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: { increment: 1 } },
      select: { failedLoginAttempts: true },
    });

    const attempts = updated.failedLoginAttempts;
    const locked = attempts >= AuthService.MAX_FAILED_LOGIN_ATTEMPTS;
    if (locked) {
      await this.prismaService.user.update({
        where: { id: userId },
        data: {
          lockedUntil: new Date(
            Date.now() + AuthService.LOCKOUT_DURATION_MS,
          ),
        },
      });
    }
    return { attempts, locked };
  }

  // Fire-and-forget audit write — an audit failure must never break the
  // login path itself; it is logged server-side and dropped. ip/userAgent
  // travel in metadata until the AuditLog model grows dedicated columns.
  private auditAuthEvent(
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

  // ── OAuth exchange code (avoid token-in-URL after Google redirect) ────────

  private static readonly EXCHANGE_CODE_TTL_MS = 30 * 1000; // 30 seconds

  // Mint a short-lived single-use code that the frontend will POST to
  // /auth/exchange immediately. The actual access/refresh tokens never go
  // through the URL.
  public async createExchangeCode(userId: string): Promise<string> {
    const code = randomUUID();
    await this.prismaService.authExchangeCode.create({
      data: {
        code,
        userId,
        expiresAt: new Date(Date.now() + AuthService.EXCHANGE_CODE_TTL_MS),
      },
    });
    return code;
  }

  // Consume an exchange code: validate, delete (single-use), then issue real
  // tokens the same way a regular login would.
  public async exchangeCodeForTokens(
    code: string,
    ip?: string,
    userAgent?: string,
  ) {
    const record = await this.prismaService.authExchangeCode.findUnique({
      where: { code },
    });

    if (!record) {
      throw new UnauthorizedException('Invalid or expired exchange code');
    }

    // Burn the code regardless of outcome so it can never be reused.
    await this.prismaService.authExchangeCode.delete({ where: { code } });

    if (record.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired exchange code');
    }

    const user = await this.userService.findById(record.userId);
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Account is suspended');
    }

    const sessionId = randomUUID();
    // OAuth sign-ins behave like "remember me" — the Google flow has no
    // checkbox, and forcing daily re-logins there would be hostile. Matches
    // the reference implementation.
    const rememberMe = true;
    const ttlMs = this.sessionTtlMs(rememberMe);
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

    await this.enforceSessionLimit(user.id);

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

    await this.loginAlertService.handleSuccessfulLogin('auth.google_login', {
      userId: user.id,
      email: user.email,
      ip,
      userAgent,
    });

    const { password: _password, ...userWithoutPassword } = user;
    return {
      user: userWithoutPassword,
      accessToken,
      refreshToken,
      rememberMe,
    };
  }

  // ── Token helpers ──────────────────────────────────────────────────────────

  // One-time email tokens (verification, password reset) are sent to the user
  // in plaintext but stored only as a SHA-256 hash. A DB read then can't be
  // replayed as a live token. SHA-256 (not argon2) is enough: the input is a
  // random UUID, so the hash is already infeasible to brute-force — same
  // rationale as the 2FA backup codes.
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async createVerificationToken(email: string): Promise<string> {
    // Remove any existing verification token for this email
    await this.prismaService.token.deleteMany({
      where: { email, type: 'VERIFICATION' },
    });

    const token = randomUUID();
    await this.prismaService.token.create({
      data: {
        email,
        token: this.hashToken(token),
        type: 'VERIFICATION',
        expiresIn: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
      },
    });

    // Return the plaintext token — the only place it ever exists outside the
    // user's inbox.
    return token;
  }

  async verifyEmail(token: string) {
    const hashedToken = this.hashToken(token);
    const record = await this.prismaService.token.findUnique({
      where: { token: hashedToken },
    });

    if (!record || record.type !== 'VERIFICATION') {
      throw new BadRequestException('Invalid verification token');
    }

    if (new Date() > record.expiresIn) {
      await this.prismaService.token.delete({ where: { token: hashedToken } });
      throw new BadRequestException('Verification token has expired. Please register again.');
    }

    await this.prismaService.user.update({
      where: { email: record.email },
      data: { isVerified: true },
    });

    await this.prismaService.token.delete({ where: { token: hashedToken } });

    return { message: 'Email verified successfully. You can now log in.' };
  }

  private static readonly RESEND_VERIFICATION_MESSAGE =
    'If an account with this email exists and is unverified, a new verification link has been sent.';

  async resendVerification(email: string) {
    // Identical response for every case + the real work runs asynchronously,
    // so neither the message nor the timing reveals whether the account
    // exists, is already verified, or is a Google account (no enumeration).
    // Same pattern as forgotPassword.
    void this.processResendVerificationWork(email).catch((err) => {
      this.logger.error('Resend-verification background work failed', err);
    });

    return { message: AuthService.RESEND_VERIFICATION_MESSAGE };
  }

  private async processResendVerificationWork(email: string): Promise<void> {
    const user = await this.userService.findByEmail(email);

    // Skip silently for unknown, already-verified, or Google (no password,
    // email verified by Google) accounts — none of them need a link.
    if (!user || user.isVerified || user.method === 'GOOGLE') return;

    const token = await this.createVerificationToken(user.email);
    await this.mailService.sendVerificationEmail(user.email, token);

    this.auditAuthEvent('auth.verification_resent', user.id, {
      email: user.email,
    });
  }

  //google user login
  async loginGoogleUser(googleUserLogin: GoogleLoginDto, ip?: string, userAgent?: string) {
    const userExist = await this.userService.findByEmail(googleUserLogin.email);

    if (!userExist) {
      throw new NotFoundException('User not found');
    }

    if (userExist.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Account is suspended');
    }

    const sessionId = randomUUID();
    // OAuth sign-ins are persistent — see exchangeCodeForTokens.
    const rememberMe = true;
    const ttlMs = this.sessionTtlMs(rememberMe);
    const accessPayload = {
      userId: userExist.id,
      email: userExist.email,
      role: userExist.role,
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

    await this.enforceSessionLimit(userExist.id);

    await this.prismaService.session.create({
      data: {
        id: sessionId,
        userId: userExist.id,
        refreshToken: hashedRefreshToken,
        ip,
        userAgent,
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });

    return {
      userExist,
      accessToken,
      refreshToken,
      rememberMe,
    };
  }

  /**
   * Creates or updates the Google identity (`Account` row) for a user. Keyed on
   * the stable Google subject id, so a returning user is matched even if their
   * email later changes. Idempotent: an existing google link is updated in place.
   */
  private async linkGoogleAccount(userId: string, googleUser: GoogleUser) {
    const existing = await this.prismaService.account.findFirst({
      where: { provider: 'google', userId },
    });

    const expiresAt = googleUser.expiresAt
      ? new Date(googleUser.expiresAt * 1000)
      : null;

    if (existing) {
      return this.prismaService.account.update({
        where: { id: existing.id },
        data: {
          providerAccountId:
            googleUser.googleId ?? existing.providerAccountId,
          accessToken: googleUser.accessToken ?? existing.accessToken,
          refreshToken: googleUser.refreshToken ?? existing.refreshToken,
          expiresAt: expiresAt ?? existing.expiresAt,
        },
      });
    }

    return this.prismaService.account.create({
      data: {
        type: 'oauth',
        provider: 'google',
        providerAccountId: googleUser.googleId,
        userId,
        accessToken: googleUser.accessToken ?? null,
        refreshToken: googleUser.refreshToken ?? null,
        expiresAt,
      },
    });
  }

  /**
   * Google sign-in / sign-up. Matches on the stable provider subject id (not
   * email), refuses unverified Google emails, and never auto-adopts an
   * unverified local account (anti pre-hijacking). See AUTH_PARITY_SPEC.md.
   */
  async findOrCreateGoogleUser(
    googleUser: GoogleUser,
    ip?: string,
    userAgent?: string,
  ) {
    if (!googleUser?.email) {
      throw new UnauthorizedException(
        'Google did not provide an email address.',
      );
    }
    if (!googleUser.emailVerified) {
      throw new UnauthorizedException(
        'Your Google email address is not verified.',
      );
    }

    // 1. Returning user — matched on the stable Google subject id, so a later
    //    email change on either side doesn't break or mis-route the login.
    if (googleUser.googleId) {
      const account = await this.prismaService.account.findFirst({
        where: { provider: 'google', providerAccountId: googleUser.googleId },
        include: { user: true },
      });
      if (account?.user) {
        return this.loginGoogleUser(
          { email: account.user.email },
          ip,
          userAgent,
        );
      }
    }

    // 2. A local account already owns this email.
    const existingUser = await this.userService.findByEmail(googleUser.email);
    if (existingUser) {
      // Never adopt an unverified local account: a squatter could have
      // pre-registered the address to hijack the real owner's Google sign-in.
      if (!existingUser.isVerified) {
        throw new ConflictException(
          'An account with this email already exists but is not verified. ' +
            'Please verify your email address first, then sign in with Google again.',
        );
      }
      await this.linkGoogleAccount(existingUser.id, googleUser);
      this.auditAuthEvent('auth.account_linked', existingUser.id, {
        email: existingUser.email,
        provider: 'google',
      });
      // Tell the owner a new sign-in method was added; a mail failure must not
      // break sign-in.
      void this.mailService
        .sendSignInMethodAddedEmail(existingUser.email, {
          method: 'Google',
          date: new Date(),
        })
        .catch((err) =>
          this.logger.warn(
            `Failed to send sign-in-method-added alert: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      return this.loginGoogleUser({ email: existingUser.email }, ip, userAgent);
    }

    // 3. Brand-new user — Google has already verified the email.
    const newUser = await this.prismaService.user.create({
      data: {
        email: googleUser.email,
        firstname: googleUser.firstName || '',
        lastname: googleUser.lastName || '',
        picture: googleUser.avatar || null,
        password: null, // Google users have no password until they set one
        method: 'GOOGLE',
        isVerified: true,
      },
    });
    await this.linkGoogleAccount(newUser.id, googleUser);
    this.auditAuthEvent('auth.google_register', newUser.id, {
      email: newUser.email,
    });
    return this.loginGoogleUser({ email: newUser.email }, ip, userAgent);
  }

  ///////////////////////////////////////////////////////////////////////////////////

  // Identical for fresh signups and duplicate attempts — the response body
  // must never reveal whether an email is already registered.
  private static readonly REGISTRATION_MESSAGE =
    'Registration successful! Please check your email to verify your account.';

  async registerUser(createUserDto: CreateUserDto) {
    // Breach check BEFORE the duplicate-email lookup (the reference checks
    // after). If it ran only on the fresh-signup path, a breached password
    // would 400 for new emails but "succeed" for registered ones — an
    // enumeration channel that would undo the anti-enumeration work below.
    // Checked first, the response is identical either way.
    await this.assertPasswordNotBreached(createUserDto.password);

    const userExist = await this.userService.findByEmail(createUserDto.email);

    if (userExist) {
      // Same response as a successful signup, so the form can't be used to
      // probe which emails are registered (user enumeration). The real owner
      // is told by email instead. Fire-and-forget: a mail failure must not
      // turn the duplicate path into a distinguishable 500.
      void this.mailService
        .sendAccountExistsEmail(userExist.email)
        .catch((err) =>
          this.logger.error('Failed to send account-exists email', err),
        );
      this.auditAuthEvent('auth.register_duplicate', userExist.id, {
        email: userExist.email,
      });
      return { message: AuthService.REGISTRATION_MESSAGE };
    }

    const newUser = await this.userService.create(createUserDto);

    // Generate token and send verification email
    const token = await this.createVerificationToken(newUser.email);
    await this.mailService.sendVerificationEmail(newUser.email, token);

    this.auditAuthEvent('auth.register', newUser.id, { email: newUser.email });

    // Note: no user object in the response — it must be indistinguishable
    // from the duplicate path (and the full Prisma user carries the hash).
    return { message: AuthService.REGISTRATION_MESSAGE };
  }

  async loginUser(loginUserDto: LoginUserDto, ip?: string, userAgent?: string) {
    const userExist = await this.userService.findByEmail(loginUserDto.email);

    // Unknown email or Google-only account → verify against a dummy hash
    // (burns the same argon2 CPU as a real check, so response timing doesn't
    // reveal whether the email is registered), then the same generic 401 as
    // a wrong password. The real reason is logged server-side for debugging.
    if (
      !userExist ||
      userExist.method !== 'CREDENTIALS' ||
      !userExist.password
    ) {
      await argon2.verify(await this.getDummyHash(), loginUserDto.password);
      this.logger.debug(
        `Login failed for ${loginUserDto.email}: ${
          !userExist ? 'no such user' : `wrong method (${userExist.method})`
        }`,
      );
      throw new UnauthorizedException('Invalid credentials');
    }

    // Lockout check BEFORE password verification — while locked, the
    // password oracle must be closed entirely, otherwise an attacker can
    // keep brute-forcing right through the lockout window. Only reachable
    // for existing credentials accounts, and the lockout state is already
    // observable by whoever caused it, so this adds no enumeration channel.
    if (userExist.lockedUntil && userExist.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil(
        (userExist.lockedUntil.getTime() - Date.now()) / 60000,
      );
      this.auditAuthEvent('auth.login_failed', userExist.id, {
        email: userExist.email,
        reason: 'account_locked',
        ip,
        userAgent,
      });
      throw new UnauthorizedException(
        `Account is temporarily locked. Try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.`,
      );
    }

    const passwordMatches = await argon2.verify(
      userExist.password,
      loginUserDto.password,
    );

    if (!passwordMatches) {
      const { attempts, locked } = await this.registerFailedLogin(
        userExist.id,
      );
      if (locked) {
        this.auditAuthEvent('auth.account_locked', userExist.id, {
          email: userExist.email,
          attempts,
          ip,
          userAgent,
        });
        throw new UnauthorizedException(
          'Too many failed attempts. Account is locked for 15 minutes.',
        );
      }
      this.auditAuthEvent('auth.login_failed', userExist.id, {
        email: userExist.email,
        reason: 'wrong_password',
        attempts,
        ip,
        userAgent,
      });
      this.logger.debug(`Login failed for ${loginUserDto.email}: wrong password`);
      // No remaining-attempts countdown — it would only ever appear for
      // existing accounts and would leak account existence.
      throw new UnauthorizedException('Invalid credentials');
    }

    // Suspended check only after a correct password, so probing random
    // emails with wrong passwords can't discover which accounts exist but
    // are suspended.
    if (userExist.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Account is suspended');
    }

    // Successful password check — reset lockout counters if needed
    if (userExist.failedLoginAttempts > 0 || userExist.lockedUntil) {
      await this.prismaService.user.update({
        where: { id: userExist.id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    }

    if (!userExist.isVerified) {
      throw new UnauthorizedException('Please verify your email address before logging in.');
    }

    const rememberMe = !!loginUserDto.rememberMe;

    // If 2FA is enabled, issue a short-lived pre-auth token instead of
    // full tokens. We attach a jti (JWT ID) and persist it as a
    // TwoFactorAttempt row so /auth/2fa/verify can detect replays and
    // cap brute-force guesses per token regardless of source IP. The
    // rememberMe choice rides in the tempToken so it survives the 2FA step.
    if (userExist.isTwoFactorEnabled) {
      const jti = randomUUID();
      const tempTokenTtlMs = 5 * 60 * 1000;
      const tempToken = this.jwtService.sign(
        {
          userId: userExist.id,
          email: userExist.email,
          role: userExist.role,
          rememberMe,
          isTwoFactorAuthenticated: false,
        },
        { secret: this.jwtSecret, expiresIn: '5m', jwtid: jti },
      );
      await this.prismaService.twoFactorAttempt.create({
        data: {
          jti,
          userId: userExist.id,
          expiresAt: new Date(Date.now() + tempTokenTtlMs),
        },
      });
      return { requiresTwoFactor: true as const, tempToken };
    }

    const sessionId = randomUUID();
    const ttlMs = this.sessionTtlMs(rememberMe);
    const accessPayload = {
      userId: userExist.id,
      email: userExist.email,
      role: userExist.role,
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

    await this.enforceSessionLimit(userExist.id);

    await this.prismaService.session.create({
      data: {
        id: sessionId,
        userId: userExist.id,
        refreshToken: hashedRefreshToken,
        ip,
        userAgent,
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });

    // New-device check + success audit. Runs after the session exists so a
    // failure here can't block the login; the check itself reads only audit
    // rows written by previous logins.
    await this.loginAlertService.handleSuccessfulLogin('auth.login', {
      userId: userExist.id,
      email: userExist.email,
      ip,
      userAgent,
    });

    const { password, ...userWithoutPassword } = userExist;

    return {
      user: userWithoutPassword,
      accessToken,
      refreshToken, // this can go in cookie
      rememberMe,
    };
  }

  async refresh(refreshToken: string) {
    // 1. verify JWT
    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify<JwtPayload>(refreshToken, {
        secret: this.jwtRefreshSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (!payload.sessionId) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // 2. direct lookup by sessionId
    const session = await this.prismaService.session.findUnique({
      where: { id: payload.sessionId },
    });

    if (!session || session.userId !== payload.userId) {
      throw new UnauthorizedException('Refresh token not found');
    }

    // 3. verify the refresh token matches the stored hash (current or grace-period previous)
    const matchesCurrent = await argon2.verify(session.refreshToken, refreshToken);
    let isGraceHit = false;
    if (!matchesCurrent) {
      const withinGrace =
        session.previousRefreshToken &&
        session.tokenRotatedAt &&
        Date.now() - session.tokenRotatedAt.getTime() < AuthService.REFRESH_GRACE_PERIOD_MS;
      if (withinGrace) {
        const matchesPrevious = await argon2.verify(session.previousRefreshToken!, refreshToken);
        if (matchesPrevious) {
          isGraceHit = true;
        }
      }
      if (!isGraceHit) {
        await this.prismaService.session.delete({ where: { id: session.id } });
        throw new UnauthorizedException('Invalid refresh token');
      }
    }

    // 4. check expiry
    if (new Date() > session.expiresAt) {
      throw new UnauthorizedException('Refresh token expired');
    }

    // 4b. reject suspended users
    const user = await this.prismaService.user.findUnique({
      where: { id: payload.userId },
      select: { status: true },
    });
    if (!user || user.status !== UserStatus.ACTIVE) {
      await this.prismaService.session.delete({ where: { id: session.id } });
      throw new UnauthorizedException('Account is suspended');
    }

    // 5. generate new tokens (sessionId stays the same across rotations;
    //    the rememberMe choice is preserved from the old token's payload)
    const rememberMe = !!payload.rememberMe;
    const ttlMs = this.sessionTtlMs(rememberMe);
    const accessPayload = {
      userId: payload.userId,
      email: payload.email,
      role: payload.role,
    };
    const refreshPayloadNew = {
      ...accessPayload,
      sessionId: session.id,
      rememberMe,
    };

    const newAccess = this.jwtService.sign(accessPayload, {
      secret: this.jwtSecret,
      expiresIn: this.accessExpiresIn,
    });
    const newRefresh = this.jwtService.sign(refreshPayloadNew, {
      secret: this.jwtRefreshSecret,
      expiresIn: Math.floor(ttlMs / 1000),
    });

    // 6. rotate: update existing session in-place, keeping previous hash for grace window
    await this.prismaService.session.update({
      where: { id: session.id },
      data: {
        previousRefreshToken: isGraceHit ? session.previousRefreshToken : session.refreshToken,
        refreshToken: await argon2.hash(newRefresh),
        tokenRotatedAt: new Date(),
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });

    return { accessToken: newAccess, refreshToken: newRefresh, rememberMe };
  }

  async logout(refreshToken: string) {
    try {
      const payload = this.jwtService.verify<JwtPayload>(refreshToken, { secret: this.jwtRefreshSecret });

      if (payload.sessionId) {
        await this.prismaService.session
          .delete({ where: { id: payload.sessionId } })
          .catch(() => undefined); // already deleted — idempotent
      }

      return { message: 'Logged out successfully' };
    } catch {
      // Token invalid, but still return success (idempotent)
      return { message: 'Logged out successfully' };
    }
  }

  async forgotPassword(email: string) {
    // The response message is identical for known and unknown emails; we
    // also do the real work (DB writes + email send) asynchronously so
    // the response timing is constant. Without this, an attacker could
    // time the response — verified accounts take ~hundreds of ms while
    // unknown emails return instantly — and enumerate users.
    void this.processForgotPasswordWork(email).catch((err) => {
      this.logger.error('Password reset background work failed', err);
    });

    return {
      message:
        'If an account with this email exists, a password reset link has been sent.',
    };
  }

  private async processForgotPasswordWork(email: string): Promise<void> {
    const user = await this.userService.findByEmail(email);
    if (!user || !user.isVerified) return;

    await this.prismaService.token.deleteMany({
      where: { email, type: 'PASSWORD_RESET' },
    });

    const token = randomUUID();
    await this.prismaService.token.create({
      data: {
        email,
        token: this.hashToken(token),
        type: 'PASSWORD_RESET',
        expiresIn: new Date(Date.now() + 1 * 60 * 60 * 1000), // 1 hour
      },
    });

    // Email carries the plaintext token; only its hash lives in the DB.
    await this.mailService.sendPasswordResetEmail(email, token);
  }

  async resetPassword(token: string, password: string) {
    // All policy checks (breach, expiry, history) run read-only BEFORE the
    // atomic consume below — a rejected password must not burn the
    // single-use token, so the user can retry from the same reset link.
    await this.assertPasswordNotBreached(password);

    const hashedToken = this.hashToken(token);
    const record = await this.prismaService.token.findUnique({
      where: { token: hashedToken },
      select: { email: true, expiresIn: true },
    });
    if (!record) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    if (record.expiresIn < new Date()) {
      throw new BadRequestException(
        'Reset token has expired. Please request a new one.',
      );
    }

    const user = await this.prismaService.user.findUnique({
      where: { email: record.email },
      select: { id: true, password: true },
    });
    if (!user) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    // Reject reuse of the current or any of the last 5 passwords.
    await this.passwordHistoryService.assertNotReused(
      user.id,
      password,
      user.password,
    );

    // Atomic consume: delete throws if the row is already gone. Two
    // concurrent requests race on this delete — exactly one reaches the
    // password write below.
    try {
      await this.prismaService.token.delete({ where: { token: hashedToken } });
    } catch {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const hashedPassword = await argon2.hash(password);

    await this.passwordHistoryService.record(user.id, user.password);

    await this.prismaService.$transaction([
      this.prismaService.user.update({
        where: { email: record.email },
        data: { password: hashedPassword },
      }),
      this.prismaService.session.deleteMany({
        where: { user: { email: record.email } },
      }),
    ]);

    return {
      message: 'Password reset successfully. You can now log in with your new password.',
    };
  }

  // ── Email change (with re-verification of the new address) ────────────────────

  /**
   * Starts an email change: re-confirms the user's password, ensures the new
   * address is free, and emails a confirmation link to the NEW address. The
   * account email isn't touched until that link is confirmed, proving the user
   * controls the new mailbox.
   */
  async requestEmailChange(userId: string, newEmail: string, password: string) {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
    });
    if (!user) throw new NotFoundException('User not found');

    if (!user.password) {
      throw new BadRequestException(
        'Set a password before changing your email address.',
      );
    }

    const isValid = await argon2.verify(user.password, password);
    if (!isValid) {
      throw new UnauthorizedException('Password is incorrect');
    }

    if (newEmail === user.email) {
      throw new BadRequestException('That is already your email address.');
    }

    const taken = await this.userService.findByEmail(newEmail);
    if (taken) {
      throw new ConflictException('That email address is already in use.');
    }

    // Drop any earlier pending change for this user, then issue a fresh token.
    await this.prismaService.token.deleteMany({
      where: { userId, type: 'EMAIL_CHANGE' },
    });

    const token = randomUUID();
    await this.prismaService.token.create({
      data: {
        email: newEmail, // the pending NEW address
        token: this.hashToken(token),
        type: 'EMAIL_CHANGE',
        userId,
        expiresIn: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
      },
    });

    // Link goes to the new address; the DB only holds its hash.
    await this.mailService.sendEmailChangeVerification(newEmail, token);

    this.auditAuthEvent('auth.email_change_requested', userId, {
      email: user.email,
      newEmail,
    });

    return {
      message:
        'A confirmation link has been sent to your new email address. The change takes effect once you confirm it.',
    };
  }

  /**
   * Completes an email change from the confirmation link. Re-checks that the
   * new address is still free (it could have been taken since the request),
   * switches the account email, and alerts the OLD address that it changed.
   */
  async confirmEmailChange(token: string) {
    const hashedToken = this.hashToken(token);
    const record = await this.prismaService.token.findUnique({
      where: { token: hashedToken },
    });

    if (!record || record.type !== 'EMAIL_CHANGE' || !record.userId) {
      throw new BadRequestException('Invalid email change link');
    }

    if (new Date() > record.expiresIn) {
      await this.prismaService.token.delete({ where: { token: hashedToken } });
      throw new BadRequestException(
        'This email change link has expired. Please request a new one.',
      );
    }

    const user = await this.prismaService.user.findUnique({
      where: { id: record.userId },
    });
    if (!user) {
      await this.prismaService.token.delete({ where: { token: hashedToken } });
      throw new BadRequestException('Account not found');
    }

    const newEmail = record.email;
    const oldEmail = user.email;

    if (oldEmail !== newEmail) {
      const taken = await this.prismaService.user.findUnique({
        where: { email: newEmail },
      });
      if (taken && taken.id !== user.id) {
        await this.prismaService.token.delete({ where: { token: hashedToken } });
        throw new ConflictException('That email address is now in use.');
      }

      await this.prismaService.user.update({
        where: { id: user.id },
        data: { email: newEmail },
      });

      // Tell the OLD address — the only mailbox the original owner still
      // controls — so a hijacked change is noticed. Fire-and-forget: an
      // alert failure must not undo a completed change.
      void this.mailService
        .sendEmailChangedAlert(oldEmail, newEmail)
        .catch((err) =>
          this.logger.error('Failed to send email-changed alert', err),
        );

      this.auditAuthEvent('auth.email_changed', user.id, {
        from: oldEmail,
        to: newEmail,
      });
    }

    await this.prismaService.token.delete({ where: { token: hashedToken } });

    return { message: 'Your email address has been updated successfully.' };
  }
}
