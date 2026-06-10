import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { CreateUserDto } from '../auth/dto/create-user.dto';
import { PrismaService } from '../prisma/prisma.service';
import { hash, verify } from 'argon2';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { JwtPayload } from '../auth/types/jwt-payload.type';

@Injectable()
export class UserService {
  // Same fallback rule as AuthService: refresh tokens use their own
  // secret when JWT_REFRESH_SECRET is set, otherwise JWT_SECRET.
  private readonly jwtRefreshSecret: string;

  constructor(
    private readonly prismaService: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.jwtRefreshSecret =
      this.configService.get<string>('JWT_REFRESH_SECRET') ??
      this.configService.getOrThrow<string>('JWT_SECRET');
  }

  public async findByEmail(email: string) {
    return this.prismaService.user.findUnique({
      where: { email },
    });
  }

  public async create(createUserDto: CreateUserDto) {
    const { passwordRepeat, password, ...rest } = createUserDto;
    const hashedPassword = password ? await hash(password) : null;
    return this.prismaService.user.create({
      data: { password: hashedPassword, ...rest },
    });
  }

  public async findById(id: string) {
    return this.prismaService.user.findUnique({
      where: { id },
    });
  }

  private readonly profileSelect = {
    id: true,
    firstname: true,
    lastname: true,
    email: true,
    role: true,
    picture: true,
    method: true,
    createdAt: true,
    isTwoFactorEnabled: true,
  } as const;

  public async getProfile(id: string) {
    const user = await this.prismaService.user.findUnique({
      where: { id },
      select: this.profileSelect,
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  public async updateProfile(id: string, dto: UpdateProfileDto) {
    return this.prismaService.user.update({
      where: { id },
      data: {
        firstname: dto.firstName,
        lastname: dto.lastName,
      },
      select: this.profileSelect,
    });
  }

  public async changePassword(id: string, dto: ChangePasswordDto) {
    const user = await this.prismaService.user.findUnique({ where: { id } });
    if (!user || !user.password) {
      throw new BadRequestException('Cannot change password for this account type');
    }
    const isValid = await verify(user.password, dto.currentPassword);
    if (!isValid) {
      throw new BadRequestException('Current password is incorrect');
    }
    const hashed = await hash(dto.newPassword);
    await this.prismaService.user.update({
      where: { id },
      data: { password: hashed },
    });
  }

  // ── Sessions ────────────────────────────────────────────────────────────

  // The refresh cookie's JWT carries the sessionId, so the caller's own
  // session is identified by one signature check instead of argon2-verifying
  // every stored hash. A missing/invalid cookie just means no session gets
  // flagged as current — the endpoints themselves are guarded by the access
  // token, not by this cookie.
  private resolveCurrentSessionId(refreshToken?: string): string | null {
    if (!refreshToken) return null;
    try {
      const payload = this.jwtService.verify<JwtPayload>(refreshToken, {
        secret: this.jwtRefreshSecret,
      });
      return payload.sessionId ?? null;
    } catch {
      return null;
    }
  }

  public async getSessions(userId: string, currentRefreshToken?: string) {
    const currentSessionId = this.resolveCurrentSessionId(currentRefreshToken);
    const sessions = await this.prismaService.session.findMany({
      where: { userId, expiresAt: { gt: new Date() } },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        ip: true,
        userAgent: true,
        createdAt: true,
        updatedAt: true,
        expiresAt: true,
      },
    });

    return sessions.map((session) => ({
      ...session,
      isCurrent: session.id === currentSessionId,
    }));
  }

  public async revokeSession(userId: string, sessionId: string) {
    const session = await this.prismaService.session.findUnique({
      where: { id: sessionId },
      select: { userId: true },
    });
    // Same 404 whether the session does not exist or belongs to someone
    // else — never confirm another user's session ids.
    if (!session || session.userId !== userId) {
      throw new NotFoundException('Session not found');
    }
    await this.prismaService.session.delete({ where: { id: sessionId } });
    return { message: 'Session revoked' };
  }

  public async revokeOtherSessions(
    userId: string,
    currentRefreshToken?: string,
  ) {
    const currentSessionId = this.resolveCurrentSessionId(currentRefreshToken);
    const { count } = await this.prismaService.session.deleteMany({
      where: {
        userId,
        ...(currentSessionId ? { id: { not: currentSessionId } } : {}),
      },
    });
    return { message: 'Other sessions revoked', count };
  }
}
