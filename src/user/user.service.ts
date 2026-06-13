import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { CreateUserDto } from '../auth/dto/create-user.dto';
import { PrismaService } from '../prisma/prisma.service';
import { hash, verify } from 'argon2';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { PasswordBreachService } from '../libs/common/services/password-breach.service';
import { PasswordHistoryService } from '../libs/common/services/password-history.service';
import { MailService } from '../mail/mail.service';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);
  // Same fallback rule as AuthService: refresh tokens use their own
  // secret when JWT_REFRESH_SECRET is set, otherwise JWT_SECRET.
  private readonly jwtRefreshSecret: string;

  constructor(
    private readonly prismaService: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly passwordBreachService: PasswordBreachService,
    private readonly passwordHistoryService: PasswordHistoryService,
    private readonly mailService: MailService,
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
    // HIBP k-anonymity breach check; fails open on an HIBP outage so it
    // never blocks a legitimate password change.
    if (await this.passwordBreachService.isBreached(dto.newPassword)) {
      throw new BadRequestException(
        'This password has appeared in a known data breach. Please choose a different one.',
      );
    }
    // Reject reuse of the current or any of the last 5 passwords.
    await this.passwordHistoryService.assertNotReused(
      id,
      dto.newPassword,
      user.password,
    );
    const hashed = await hash(dto.newPassword);
    await this.passwordHistoryService.record(id, user.password);
    await this.prismaService.user.update({
      where: { id },
      data: { password: hashed },
    });
  }

  // ── Sign-in methods (password + linked OAuth providers) ───────────────────

  // What the profile UI needs to render the "sign-in methods" card.
  public async getSignInMethods(userId: string) {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: { password: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const accounts = await this.prismaService.account.findMany({
      where: { userId },
      select: { provider: true },
    });
    const providers = [...new Set(accounts.map((a) => a.provider))];

    return { hasPassword: !!user.password, providers };
  }

  /**
   * Sets a password for an account that doesn't have one yet (e.g. a Google
   * user adding a password so they aren't locked into a single provider).
   * Accounts that already have a password must use changePassword instead.
   */
  public async setPassword(userId: string, newPassword: string) {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.password) {
      throw new BadRequestException(
        'A password is already set. Use change password instead.',
      );
    }
    // HIBP k-anonymity breach check (fails open on outage), same as changePassword.
    if (await this.passwordBreachService.isBreached(newPassword)) {
      throw new BadRequestException(
        'This password has appeared in a known data breach. Please choose a different one.',
      );
    }
    const hashed = await hash(newPassword);
    await this.prismaService.user.update({
      where: { id: userId },
      data: { password: hashed },
    });

    this.audit('auth.password_set', userId, { email: user.email });

    // Alert the owner a new sign-in method was added; a mail failure must not
    // break the request.
    void this.mailService
      .sendSignInMethodAddedEmail(user.email, {
        method: 'Password',
        date: new Date(),
      })
      .catch((err) =>
        this.logger.warn(
          `Failed to send sign-in-method-added alert: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }

  /**
   * Unlinks an OAuth provider. Refuses to remove the user's last remaining way
   * to sign in — they must keep at least a password or another linked provider,
   * otherwise they'd lock themselves out.
   */
  public async disconnectProvider(userId: string, provider: string) {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: { password: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const accounts = await this.prismaService.account.findMany({
      where: { userId },
      select: { provider: true },
    });

    const linked = accounts.filter((a) => a.provider === provider);
    if (linked.length === 0) {
      throw new NotFoundException(`No linked ${provider} account`);
    }

    const otherProviders = accounts.filter(
      (a) => a.provider !== provider,
    ).length;
    const remainingMethods = (user.password ? 1 : 0) + otherProviders;
    if (remainingMethods === 0) {
      throw new BadRequestException(
        "You can't disconnect your only sign-in method. Set a password first.",
      );
    }

    await this.prismaService.account.deleteMany({
      where: { userId, provider },
    });

    this.audit('auth.provider_disconnected', userId, { provider });

    return { message: `${provider} disconnected` };
  }

  // Fire-and-forget audit write, same contract as AuthService.auditAuthEvent.
  private audit(
    action: string,
    userId: string,
    metadata: Record<string, unknown>,
  ): void {
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
