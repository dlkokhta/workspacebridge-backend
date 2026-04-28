import {
  BadRequestException,
  ConflictException,
  Injectable,
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

@Injectable()
export class AuthService {
  private readonly jwtSecret: string;
  private readonly accessExpiresIn: string;
  private readonly refreshExpiresIn: string;

  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly prismaService: PrismaService,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
  ) {
    this.jwtSecret = this.configService.getOrThrow<string>('JWT_SECRET');
    this.accessExpiresIn =
      this.configService.get<string>('JWT_ACCESS_EXPIRES_IN') || '15m';
    this.refreshExpiresIn =
      this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') || '7d';
  }

  private static readonly MAX_FAILED_LOGIN_ATTEMPTS = 5;
  private static readonly LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

  private async registerFailedLogin(userId: string, currentAttempts: number) {
    const newAttempts = currentAttempts + 1;
    const shouldLock = newAttempts >= AuthService.MAX_FAILED_LOGIN_ATTEMPTS;

    await this.prismaService.user.update({
      where: { id: userId },
      data: {
        failedLoginAttempts: newAttempts,
        lockedUntil: shouldLock
          ? new Date(Date.now() + AuthService.LOCKOUT_DURATION_MS)
          : null,
      },
    });
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
      secret: this.jwtSecret,
      expiresIn: this.refreshExpiresIn,
    });

    const hashedRefreshToken = await argon2.hash(refreshToken);

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
        expiresAt: googleUserRegister.expiresAt || 0,
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

    if (!userExist) {
      throw new NotFoundException('User not found. Please register first.');
    }

    if (userExist.method === 'GOOGLE') {
      throw new UnauthorizedException(
        'This account uses Google Sign-In. Please use the "Continue with Google" button.',
      );
    }

    // Account lockout check
    if (userExist.lockedUntil && userExist.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil(
        (userExist.lockedUntil.getTime() - Date.now()) / 60000,
      );
      throw new UnauthorizedException(
        `Account locked due to too many failed login attempts. Try again in ${minutesLeft} minute(s).`,
      );
    }

    if (!userExist.password) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isValidPassword = await argon2.verify(
      userExist.password,
      loginUserDto.password,
    );

    if (!isValidPassword) {
      await this.registerFailedLogin(userExist.id, userExist.failedLoginAttempts);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!userExist.isVerified) {
      throw new UnauthorizedException('Please verify your email address before logging in.');
    }

    // Successful password check — reset lockout counters if needed
    if (userExist.failedLoginAttempts > 0 || userExist.lockedUntil) {
      await this.prismaService.user.update({
        where: { id: userExist.id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    }

    // If 2FA is enabled, issue a short-lived pre-auth token instead of full tokens
    if (userExist.isTwoFactorEnabled) {
      const tempToken = this.jwtService.sign(
        {
          userId: userExist.id,
          email: userExist.email,
          role: userExist.role,
          isTwoFactorAuthenticated: false,
        },
        { secret: this.jwtSecret, expiresIn: '5m' },
      );
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
      secret: this.jwtSecret,
      expiresIn: this.refreshExpiresIn,
    });

    const hashedRefreshToken = await argon2.hash(refreshToken);

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
        secret: this.jwtSecret,
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

    // 3. verify the refresh token matches the stored hash
    const isValid = await argon2.verify(session.refreshToken, refreshToken);
    if (!isValid) {
      // Token doesn't match — possible reuse of a rotated token. Revoke this session.
      await this.prismaService.session.delete({ where: { id: session.id } });
      throw new UnauthorizedException('Invalid refresh token');
    }

    // 4. check expiry
    if (new Date() > session.expiresAt) {
      throw new UnauthorizedException('Refresh token expired');
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
      secret: this.jwtSecret,
      expiresIn: this.refreshExpiresIn,
    });

    // 6. rotate: update existing session in-place
    await this.prismaService.session.update({
      where: { id: session.id },
      data: {
        refreshToken: await argon2.hash(newRefresh),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    return { accessToken: newAccess, refreshToken: newRefresh };
  }

  async logout(refreshToken: string) {
    try {
      const payload = this.jwtService.verify<JwtPayload>(refreshToken, { secret: this.jwtSecret });

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
    const user = await this.userService.findByEmail(email);

    // Always return the same message to prevent email enumeration
    if (!user || !user.isVerified) {
      return {
        message:
          'If an account with this email exists, a password reset link has been sent.',
      };
    }

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

    return {
      message:
        'If an account with this email exists, a password reset link has been sent.',
    };
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
