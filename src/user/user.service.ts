import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
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
import { AuditAction } from '../libs/common/audit/audit-actions';
import { writeAuditLog } from '../libs/common/audit/audit-log.util';

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

  /**
   * Permanently deletes the caller's own account (hard delete). Credential
   * accounts must re-confirm with their current password; OAuth-only accounts
   * (no password) skip that check.
   *
   * The `sessions`, `accounts` and `workspaces` (owner) foreign keys are
   * `ON DELETE RESTRICT`, so they must be cleared before the user row goes —
   * we do it in one transaction. Deleting an owned workspace cascades to all
   * of its data (messages, files, members, …); a freelancer's hard delete
   * therefore removes the workspaces they own outright (there is no other
   * owner to hand them to). Everything else that points at the user
   * (`backupCodes`, `credentials`, `passwordHistory`, `workspaceMemberships`,
   * `notifications`, sent messages, …) is `ON DELETE CASCADE` and goes with
   * the user.delete(). Tokens have no FK, so we clear them by email for hygiene.
   */
  public async deleteOwnAccount(userId: string, password?: string) {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
    });
    if (!user) throw new NotFoundException('User not found');

    if (user.password) {
      if (!password) {
        throw new BadRequestException(
          'Password is required to delete your account',
        );
      }
      const isValid = await verify(user.password, password);
      if (!isValid) {
        throw new UnauthorizedException('Password is incorrect');
      }
    }

    await this.prismaService.$transaction([
      this.prismaService.session.deleteMany({ where: { userId } }),
      this.prismaService.account.deleteMany({ where: { userId } }),
      this.prismaService.workspace.deleteMany({ where: { ownerId: userId } }),
      this.prismaService.token.deleteMany({ where: { email: user.email } }),
      this.prismaService.user.delete({ where: { id: userId } }),
    ]);

    // Logged after the fact; AuditLog has no FK to the (now-deleted) user.
    this.audit('auth.account_deleted', userId, { email: user.email });

    return { email: user.email };
  }

  /**
   * Builds a portable JSON snapshot of everything the platform holds about the
   * caller, for GDPR "right to access / data portability". Every field is
   * pulled through an explicit `select` so secrets (password hash, 2FA secret,
   * refresh-token hashes, OAuth access/refresh tokens, backup-code & passkey
   * key material) are never serialised — only non-sensitive summaries of them.
   * The password column is read solely to derive `hasPassword` and is dropped
   * before the document is assembled.
   */
  public async exportOwnData(userId: string) {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstname: true,
        lastname: true,
        email: true,
        role: true,
        plan: true,
        status: true,
        picture: true,
        method: true,
        isVerified: true,
        isTwoFactorEnabled: true,
        createdAt: true,
        updatedAt: true,
        password: true, // only to derive hasPassword — never serialised
      },
    });
    if (!user) throw new NotFoundException('User not found');

    const [
      sessions,
      linkedAccounts,
      backupCodes,
      passkeys,
      activity,
      ownedWorkspaces,
      memberships,
      privateTasks,
    ] = await Promise.all([
      this.prismaService.session.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: {
          ip: true,
          userAgent: true,
          createdAt: true,
          updatedAt: true,
          expiresAt: true,
        },
      }),
      this.prismaService.account.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: { provider: true, providerAccountId: true, createdAt: true },
      }),
      this.prismaService.backupCode.findMany({
        where: { userId },
        select: { usedAt: true },
      }),
      this.prismaService.credential.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: {
          name: true,
          deviceType: true,
          backedUp: true,
          transports: true,
          createdAt: true,
          lastUsedAt: true,
        },
      }),
      this.prismaService.auditLog.findMany({
        where: { actorId: userId },
        orderBy: { createdAt: 'desc' },
        take: 1000,
        select: { action: true, metadata: true, createdAt: true },
      }),
      this.prismaService.workspace.findMany({
        where: { ownerId: userId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          description: true,
          color: true,
          status: true,
          createdAt: true,
        },
      }),
      this.prismaService.workspaceMember.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: {
          role: true,
          createdAt: true,
          workspace: { select: { id: true, name: true } },
        },
      }),
      this.prismaService.privateTask.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: {
          title: true,
          status: true,
          workspaceId: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);

    const { password, ...profile } = user;

    this.audit('auth.data_exported', userId, { email: profile.email });

    return {
      format: 'workspacebridge-account-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      profile: {
        id: profile.id,
        firstName: profile.firstname,
        lastName: profile.lastname,
        email: profile.email,
        role: profile.role,
        plan: profile.plan,
        status: profile.status,
        picture: profile.picture,
        signInMethod: profile.method,
        isVerified: profile.isVerified,
        isTwoFactorEnabled: profile.isTwoFactorEnabled,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      },
      security: {
        hasPassword: !!password,
        twoFactorEnabled: profile.isTwoFactorEnabled,
        backupCodes: {
          total: backupCodes.length,
          used: backupCodes.filter((c) => c.usedAt !== null).length,
        },
        passkeys,
      },
      linkedAccounts,
      sessions,
      activity,
      workspaces: {
        owned: ownedWorkspaces,
        memberOf: memberships.map((m) => ({
          workspaceId: m.workspace.id,
          workspaceName: m.workspace.name,
          role: m.role,
          joinedAt: m.createdAt,
        })),
      },
      privateTasks,
    };
  }

  /**
   * Paginated security activity timeline for the caller — their own `auth.*`
   * audit rows (sign-ins, failed attempts, new-device logins, 2FA / passkey /
   * email / password changes, etc.), newest first. Only non-sensitive context
   * (ip / userAgent / device / provider) is lifted out of the metadata JSON;
   * the raw blob is never returned wholesale.
   */
  public async getActivity(userId: string, page = 1, limit = 20) {
    const take = Math.min(Math.max(limit, 1), 100);
    const safePage = Math.max(page, 1);
    const skip = (safePage - 1) * take;

    const where: Prisma.AuditLogWhereInput = {
      actorId: userId,
      action: { startsWith: 'auth.' },
    };

    const [rows, total] = await this.prismaService.$transaction([
      this.prismaService.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: { id: true, action: true, metadata: true, createdAt: true },
      }),
      this.prismaService.auditLog.count({ where }),
    ]);

    const asString = (value: unknown) =>
      typeof value === 'string' ? value : undefined;

    const items = rows.map((row) => {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        action: row.action,
        createdAt: row.createdAt,
        context: {
          ip: asString(meta.ip),
          userAgent: asString(meta.userAgent),
          device: asString(meta.device),
          provider: asString(meta.provider),
        },
      };
    });

    return {
      items,
      total,
      page: safePage,
      limit: take,
      hasMore: skip + rows.length < total,
    };
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

  // Fire-and-forget audit write; email/ip/userAgent land in dedicated columns.
  private audit(
    action: AuditAction,
    userId: string,
    metadata: Record<string, unknown>,
  ): void {
    writeAuditLog(this.prismaService, this.logger, action, userId, metadata);
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
