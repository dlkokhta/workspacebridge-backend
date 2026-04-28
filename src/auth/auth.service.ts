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
import { PrismaService } from '../prisma/prisma.service';
import * as argon2 from 'argon2';
import { GoogleRegisterDto } from './dto/google-register.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { MailService } from '../mail/mail.service';
import { randomUUID } from 'crypto';

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly prismaService: PrismaService,
    private readonly mailService: MailService,
  ) {}

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
  async loginGoogleUser(googleUserLogin: GoogleLoginDto) {
    const userExist = await this.userService.findByEmail(googleUserLogin.email);

    if (!userExist) {
      throw new NotFoundException('User not found');
    }

    // Generate tokens
    const payload = {
      userId: userExist.id,
      email: userExist.email,
      role: userExist.role,
    };
    const accessToken = this.jwtService.sign(payload, {
      secret: process.env.JWT_SECRET,
      expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    });
    const refreshToken = this.jwtService.sign(payload, {
      secret: process.env.JWT_SECRET,
      expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
    });

    const hashedRefreshToken = await argon2.hash(refreshToken);

    await this.prismaService.session.create({
      data: {
        userId: userExist.id,
        refreshToken: hashedRefreshToken,
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
        type: 'oauth', // or 'google'
        provider: 'google',
        userId: newUser.id,
        accessToken: googleUserRegister.accessToken || null,
        refreshToken: googleUserRegister.refreshToken || null,
        expiresAt: googleUserRegister.expiresAt || 0,
      },
    });
    return { newUser, newAccount };
  }

  async findOrCreateGoogleUser(googleUser: any) {
    const existingUser = await this.userService.findByEmail(googleUser.email);

    if (existingUser) {
      return this.loginGoogleUser({ email: googleUser.email });
    }

    const newUser = await this.registerGoogleUser({
      email: googleUser.email,
      firstName: googleUser.firstName,
      lastName: googleUser.lastName,
      provider: 'google',
      googleId: googleUser.googleId,
      avatar: googleUser.avatar,
    });

    return this.loginGoogleUser({ email: newUser.newUser.email });
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

    if (!userExist.password) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isValidPassword = await argon2.verify(
      userExist.password,
      loginUserDto.password,
    );

    if (!isValidPassword) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!userExist.isVerified) {
      throw new UnauthorizedException('Please verify your email address before logging in.');
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
        { secret: process.env.JWT_SECRET, expiresIn: '5m' },
      );
      return { requiresTwoFactor: true as const, tempToken };
    }

    // Generate tokens
    const payload = {
      userId: userExist.id,
      email: userExist.email,
      role: userExist.role,
    };
    const accessToken = this.jwtService.sign(payload, {
      secret: process.env.JWT_SECRET,
      expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    });
    const refreshToken = this.jwtService.sign(payload, {
      secret: process.env.JWT_SECRET,
      expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
    });

    const hashedRefreshToken = await argon2.hash(refreshToken);

    await this.prismaService.session.create({
      data: {
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
    let payload: any;
    try {
      payload = this.jwtService.verify(refreshToken, {
        secret: process.env.JWT_SECRET,
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // 2. look up all sessions for this user and verify the refresh token hash
    const sessions = await this.prismaService.session.findMany({
      where: { userId: payload.userId },
    });

    let session: any = null;
    for (const s of sessions) {
      if (await argon2.verify(s.refreshToken, refreshToken)) {
        session = s;
        break;
      }
    }

    if (!session) {
      throw new UnauthorizedException('Refresh token not found');
    }

    // 3. check expiry
    if (new Date() > session.expiresAt) {
      throw new UnauthorizedException('Refresh token expired');
    }

    // 4. generate new tokens
    const newPayload = {
      userId: payload.userId,
      email: payload.email,
      role: payload.role,
    };
    const newAccess = this.jwtService.sign(newPayload, {
      secret: process.env.JWT_SECRET,
      expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    });
    const newRefresh = this.jwtService.sign(newPayload, {
      secret: process.env.JWT_SECRET,
      expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
    });

    // 5. rotate: update existing session in-place (safer than delete+create)
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
      const payload = this.jwtService.verify(refreshToken, { secret: process.env.JWT_SECRET });
      await this.prismaService.session.deleteMany({
        where: { userId: payload.userId },
      });
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
