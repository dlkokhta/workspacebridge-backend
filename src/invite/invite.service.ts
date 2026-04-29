import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'crypto';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { SendInviteDto } from './dto/send-invite.dto';

@Injectable()
export class InviteService {
  private readonly jwtSecret: string;
  private readonly accessExpiresIn: string;
  private readonly refreshExpiresIn: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.jwtSecret = this.configService.getOrThrow<string>('JWT_SECRET');
    this.accessExpiresIn =
      this.configService.get<string>('JWT_ACCESS_EXPIRES_IN') ?? '15m';
    this.refreshExpiresIn =
      this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') ?? '7d';
  }

  async sendInvite(workspaceId: string, ownerId: string, dto: SendInviteDto) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');
    if (workspace.ownerId !== ownerId) throw new ForbiddenException('Access denied');

    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await this.prisma.workspaceInvite.create({
      data: { token, email: dto.email, workspaceId, expiresAt },
    });

    await this.mailService.sendWorkspaceInviteEmail(
      dto.email,
      token,
      workspace.name,
    );

    return { message: 'Invite sent' };
  }

  async generateLink(workspaceId: string, ownerId: string) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');
    if (workspace.ownerId !== ownerId) throw new ForbiddenException('Access denied');

    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await this.prisma.workspaceInvite.create({
      data: { token, email: null, workspaceId, expiresAt },
    });

    const frontendUrl = this.configService.get<string>('FRONTEND_URL');
    return { link: `${frontendUrl}/invite/${token}` };
  }

  async getInvite(token: string) {
    const invite = await this.prisma.workspaceInvite.findUnique({
      where: { token },
      include: {
        workspace: { select: { id: true, name: true, color: true, description: true } },
      },
    });

    if (!invite) throw new NotFoundException('Invite not found');
    if (invite.usedAt) throw new BadRequestException('Invite already used');
    if (invite.expiresAt < new Date()) throw new BadRequestException('Invite expired');

    return {
      email: invite.email,
      workspace: invite.workspace,
    };
  }

  async acceptInvite(token: string, dto: AcceptInviteDto, ip?: string, userAgent?: string) {
    const invite = await this.prisma.workspaceInvite.findUnique({
      where: { token },
      include: { workspace: true },
    });

    if (!invite) throw new NotFoundException('Invite not found');
    if (invite.usedAt) throw new BadRequestException('Invite already used');
    if (invite.expiresAt < new Date()) throw new BadRequestException('Invite expired');

    // For shareable links (no email), require the user to provide one — handled in controller via a different DTO if needed.
    // Here we use the email stored on the invite.
    if (!invite.email) throw new BadRequestException('This is a shareable link — use the link directly to set your email');

    const existing = await this.prisma.user.findUnique({ where: { email: invite.email } });
    if (existing) throw new BadRequestException('An account with this email already exists. Please log in instead.');

    const hashedPassword = await argon2.hash(dto.password);

    const user = await this.prisma.user.create({
      data: {
        email: invite.email,
        password: hashedPassword,
        role: UserRole.CLIENT,
        isVerified: true,
      },
    });

    await this.prisma.workspaceMember.create({
      data: { workspaceId: invite.workspace.id, userId: user.id },
    });

    await this.prisma.workspaceInvite.update({
      where: { token },
      data: { usedAt: new Date() },
    });

    const sessionId = randomUUID();
    const payload = { userId: user.id, email: user.email, role: user.role };
    const refreshPayload = { ...payload, sessionId };

    const accessToken = this.jwtService.sign(payload, {
      secret: this.jwtSecret,
      expiresIn: this.accessExpiresIn,
    });
    const refreshToken = this.jwtService.sign(refreshPayload, {
      secret: this.jwtSecret,
      expiresIn: this.refreshExpiresIn,
    });

    const hashedRefresh = await argon2.hash(refreshToken);

    await this.prisma.session.create({
      data: {
        id: sessionId,
        userId: user.id,
        refreshToken: hashedRefresh,
        ip,
        userAgent,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    return {
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, role: user.role },
      workspaceId: invite.workspace.id,
    };
  }
}
