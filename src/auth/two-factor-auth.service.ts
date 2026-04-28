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

@Injectable()
export class TwoFactorAuthService {
  private readonly jwtSecret: string;
  private readonly accessExpiresIn: string;
  private readonly refreshExpiresIn: string;

  constructor(
    private readonly prismaService: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.jwtSecret = this.configService.getOrThrow<string>('JWT_SECRET');
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

    await this.prismaService.user.update({
      where: { id: userId },
      data: { twoFactorSecret: secret.base32 },
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
      secret: user.twoFactorSecret,
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

  async disableTwoFactor(userId: string, code: string) {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
    });

    if (!user?.isTwoFactorEnabled || !user?.twoFactorSecret) {
      throw new BadRequestException('2FA is not enabled on this account');
    }

    const isValid = speakeasy.totp.verify({
      secret: user.twoFactorSecret,
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
    let payload: any;
    try {
      payload = this.jwtService.verify(tempToken, {
        secret: this.jwtSecret,
      });
    } catch {
      throw new UnauthorizedException(
        'Invalid or expired session. Please log in again.',
      );
    }

    if (payload.isTwoFactorAuthenticated !== false) {
      throw new UnauthorizedException('Invalid token type');
    }

    const user = await this.prismaService.user.findUnique({
      where: { id: payload.userId },
    });

    if (!user?.isTwoFactorEnabled || !user?.twoFactorSecret) {
      throw new BadRequestException('2FA is not configured for this account');
    }

    const isValid = speakeasy.totp.verify({
      secret: user.twoFactorSecret,
      encoding: 'base32',
      token: code,
      window: 1,
    });

    if (!isValid) {
      throw new UnauthorizedException('Invalid authentication code');
    }

    const tokenPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
    };

    const accessToken = this.jwtService.sign(tokenPayload, {
      secret: this.jwtSecret,
      expiresIn: this.accessExpiresIn,
    });

    const refreshToken = this.jwtService.sign(tokenPayload, {
      secret: this.jwtSecret,
      expiresIn: this.refreshExpiresIn,
    });

    const hashedRefreshToken = await argon2.hash(refreshToken);

    await this.prismaService.session.create({
      data: {
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
