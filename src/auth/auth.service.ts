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
import { GoogleRegisterDto } from './dto/google-register.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { MailService } from '../mail/mail.service';
import { randomUUID } from 'crypto';
import { JwtPayload } from './types/jwt-payload.type';
import { GoogleUser } from './types/google-user.type';
import { UserStatus } from '@prisma/client';

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
  private readonly refreshExpiresIn: string;

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
    this.refreshExpiresIn =
      this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') || '7d';
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
  private async registerFailedLogin(userId: string) {
    const updated = await this.prismaService.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: { increment: 1 } },
      select: { failedLoginAttempts: true },
    });

    if (
      updated.failedLoginAttempts >= AuthService.MAX_FAILED_LOGIN_ATTEMPTS
    ) {
      await this.prismaService.user.update({
        where: { id: userId },
        data: {
          lockedUntil: new Date(
            Date.now() + AuthService.LOCKOUT_DURATION_MS,
          ),
        },
      });
    }
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

    await this.enforceSessionLimit(user.id);

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

    const { password: _password, ...userWithoutPassword } = user;
    return {
      user: userWithoutPassword,
      accessToken,
      refreshToken,
    };
  }

  // ── Token helpers ──────────────────────────────────────────────────────────

  private async createVerificationToken(email: string): Promise<string> {
    // Remove any existing verification token for this email
    await this.prismaService.token.deleteMany({
      where: { email, type: 'VERIFICATION' },
    });

    const token = randomUUID();
    await this.prismaService.token.create({
      data: {
        email,
        token,
        type: 'VERIFICATION',
        expiresIn: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
      },
    });

    return token;
  }

  async verifyEmail(token: string) {
    const record = await this.prismaService.token.findUnique({
      where: { token },
    });

    if (!record || record.type !== 'VERIFICATION') {
      throw new BadRequestException('Invalid verification token');
    }

    if (new Date() > record.expiresIn) {
      await this.prismaService.token.delete({ where: { token } });
      throw new BadRequestException('Verification token has expired. Please register again.');
    }

    await this.prismaService.user.update({
      where: { email: record.email },
      data: { isVerified: true },
    });

    await this.prismaService.token.delete({ where: { token } });

    return { message: 'Email verified successfully. You can now log in.' };
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
    const accessPayload = {
      userId: userExist.id,
      email: userExist.email,
      role: userExist.role,
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

    await this.enforceSessionLimit(userExist.id);

    await this.prismaService.session.create({
      data: {
        id: sessionId,
        userId: userExist.id,
        refreshToken: hashedRefreshToken,
        ip,
        userAgent,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      },
    });

    return {
      userExist,
      accessToken,
      refreshToken,
    };
  }

  //google user registration
  async registerGoogleUser(googleUserRegister: GoogleRegisterDto) {
    const userExist = await this.userService.findByEmail(
      googleUserRegister.email,
    );
    if (userExist) throw new ConflictException('User already exists');

    // Create Google user directly without password
    const newUser = await this.prismaService.user.create({
      data: {
        email: googleUserRegister.email,
        firstname: googleUserRegister.firstName || '',
        lastname: googleUserRegister.lastName || '',
        password: null, // Google users don't have password
        method: 'GOOGLE',
        isVerified: true, // Email already verified by Google
      },
    });

    const newAccount = await this.prismaService.account.create({
      data: {
        type: 'oauth',
        provider: 'google',
        providerAccountId: googleUserRegister.googleId,
        userId: newUser.id,
        accessToken: googleUserRegister.accessToken || null,
        refreshToken: googleUserRegister.refreshToken || null,
        expiresAt: googleUserRegister.expiresAt
          ? new Date(googleUserRegister.expiresAt * 1000)
          : null,
      },
    });
    return { newUser, newAccount };
  }

  async findOrCreateGoogleUser(googleUser: GoogleUser, ip?: string, userAgent?: string) {
    const existingUser = await this.userService.findByEmail(googleUser.email);

    if (existingUser) {
      return this.loginGoogleUser({ email: googleUser.email }, ip, userAgent);
    }

    const newUser = await this.registerGoogleUser({
      email: googleUser.email,
      firstName: googleUser.firstName,
      lastName: googleUser.lastName,
      provider: 'google',
      googleId: googleUser.googleId,
      avatar: googleUser.avatar,
    });

    return this.loginGoogleUser({ email: newUser.newUser.email }, ip, userAgent);
  }

  ///////////////////////////////////////////////////////////////////////////////////

  async registerUser(createUserDto: CreateUserDto) {
    const userExist = await this.userService.findByEmail(createUserDto.email);
    if (userExist) throw new ConflictException('User already exists');

    const newUser = await this.userService.create(createUserDto);

    // Generate token and send verification email
    const token = await this.createVerificationToken(newUser.email);
    await this.mailService.sendVerificationEmail(newUser.email, token);

    return {
      message: 'Registration successful! Please check your email to verify your account.',
      user: newUser,
    };
  }

  async loginUser(loginUserDto: LoginUserDto, ip?: string, userAgent?: string) {
    const userExist = await this.userService.findByEmail(loginUserDto.email);

    // Constant-time password check: always run argon2.verify so timing
    // doesn't reveal whether the email is registered. Use the real hash if
    // the account exists and is a CREDENTIALS account, otherwise verify
    // against a dummy hash that always fails.
    const isCredentialsAccount =
      !!userExist && userExist.method === 'CREDENTIALS' && !!userExist.password;
    const hashToCheck = isCredentialsAccount
      ? userExist!.password!
      : await this.getDummyHash();
    const passwordMatches = await argon2.verify(
      hashToCheck,
      loginUserDto.password,
    );

    // Any of: unknown email, Google-only account, or wrong password → same
    // generic response to prevent user enumeration. The real reason is
    // logged server-side for debugging.
    if (!userExist || !isCredentialsAccount || !passwordMatches) {
      if (userExist && isCredentialsAccount && !passwordMatches) {
        // Only count failed attempts for real password-method users.
        await this.registerFailedLogin(userExist.id);
      }
      this.logger.debug(
        `Login failed for ${loginUserDto.email}: ${
          !userExist
            ? 'no such user'
            : !isCredentialsAccount
              ? `wrong method (${userExist.method})`
              : 'wrong password'
        }`,
      );
      throw new UnauthorizedException('Invalid credentials');
    }

    // Account lockout check (only meaningful once the password matched —
    // exposing it earlier would also leak whether the email is registered).
    if (userExist.lockedUntil && userExist.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil(
        (userExist.lockedUntil.getTime() - Date.now()) / 60000,
      );
      throw new UnauthorizedException(
        `Account locked due to too many failed login attempts. Try again in ${minutesLeft} minute(s).`,
      );
    }

    if (!userExist.isVerified) {
      throw new UnauthorizedException('Please verify your email address before logging in.');
    }

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

    // If 2FA is enabled, issue a short-lived pre-auth token instead of
    // full tokens. We attach a jti (JWT ID) and persist it as a
    // TwoFactorAttempt row so /auth/2fa/verify can detect replays and
    // cap brute-force guesses per token regardless of source IP.
    if (userExist.isTwoFactorEnabled) {
      const jti = randomUUID();
      const tempTokenTtlMs = 5 * 60 * 1000;
      const tempToken = this.jwtService.sign(
        {
          userId: userExist.id,
          email: userExist.email,
          role: userExist.role,
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
    const accessPayload = {
      userId: userExist.id,
      email: userExist.email,
      role: userExist.role,
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

    await this.enforceSessionLimit(userExist.id);

    await this.prismaService.session.create({
      data: {
        id: sessionId,
        userId: userExist.id,
        refreshToken: hashedRefreshToken,
        ip,
        userAgent,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      },
    });

    const { password, ...userWithoutPassword } = userExist;

    return {
      user: userWithoutPassword,
      accessToken,
      refreshToken, // this can go in cookie
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

    // 5. generate new tokens (sessionId stays the same across rotations)
    const accessPayload = {
      userId: payload.userId,
      email: payload.email,
      role: payload.role,
    };
    const refreshPayloadNew = { ...accessPayload, sessionId: session.id };

    const newAccess = this.jwtService.sign(accessPayload, {
      secret: this.jwtSecret,
      expiresIn: this.accessExpiresIn,
    });
    const newRefresh = this.jwtService.sign(refreshPayloadNew, {
      secret: this.jwtRefreshSecret,
      expiresIn: this.refreshExpiresIn,
    });

    // 6. rotate: update existing session in-place, keeping previous hash for grace window
    await this.prismaService.session.update({
      where: { id: session.id },
      data: {
        previousRefreshToken: isGraceHit ? session.previousRefreshToken : session.refreshToken,
        refreshToken: await argon2.hash(newRefresh),
        tokenRotatedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    return { accessToken: newAccess, refreshToken: newRefresh };
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
        token,
        type: 'PASSWORD_RESET',
        expiresIn: new Date(Date.now() + 1 * 60 * 60 * 1000), // 1 hour
      },
    });

    await this.mailService.sendPasswordResetEmail(email, token);
  }

  async resetPassword(token: string, password: string) {
    const record = await this.prismaService.token.findUnique({ where: { token } });

    if (!record || record.type !== 'PASSWORD_RESET') {
      throw new BadRequestException('Invalid or expired reset token');
    }

    if (new Date() > record.expiresIn) {
      await this.prismaService.token.delete({ where: { token } });
      throw new BadRequestException(
        'Reset token has expired. Please request a new one.',
      );
    }

    const hashedPassword = await argon2.hash(password);

    await this.prismaService.user.update({
      where: { email: record.email },
      data: { password: hashedPassword },
    });

    // Invalidate all sessions for security after password change
    const user = await this.prismaService.user.findUnique({
      where: { email: record.email },
    });
    if (user) {
      await this.prismaService.session.deleteMany({ where: { userId: user.id } });
    }

    await this.prismaService.token.delete({ where: { token } });

    return {
      message: 'Password reset successfully. You can now log in with your new password.',
    };
  }
}
