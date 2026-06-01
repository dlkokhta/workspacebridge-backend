import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NotificationType, WorkspaceMemberRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceService } from '../presence/presence.service';
import { MailService } from '../mail/mail.service';
import { ListNotificationsDto } from './dto/list-notifications.dto';

const DEFAULT_LIMIT = 20;
const PREVIEW_MAX_LENGTH = 140;

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly mail: MailService,
  ) {}

  async list(userId: string, query: ListNotificationsDto) {
    const limit = query.limit ?? DEFAULT_LIMIT;

    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
      select: {
        id: true,
        type: true,
        data: true,
        isRead: true,
        createdAt: true,
        workspace: { select: { id: true, name: true } },
      },
    });
  }

  async unreadCount(userId: string): Promise<{ count: number }> {
    const count = await this.prisma.notification.count({
      where: { userId, isRead: false },
    });
    return { count };
  }

  async markRead(userId: string, id: string) {
    // Scope by userId so a user can only mark their own notifications read.
    const result = await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { isRead: true },
    });
    if (result.count === 0) {
      throw new NotFoundException('Notification not found');
    }
    return { id, isRead: true };
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const result = await this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
    return { updated: result.count };
  }

  /**
   * Notifies every workspace member except the sender that a new message
   * arrived: an in-app notification row is always created, and members who are
   * not currently connected also get an email so they don't miss it.
   */
  async notifyNewMessage(params: {
    workspaceId: string;
    senderId: string;
    senderName: string;
    content: string;
  }): Promise<void> {
    const { workspaceId, senderId, senderName, content } = params;

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        name: true,
        owner: { select: { id: true, email: true } },
        members: {
          select: { role: true, user: { select: { id: true, email: true } } },
        },
      },
    });
    if (!workspace) return;

    // Everyone in the workspace, deduped, minus the sender. The owner is the
    // managing freelancer; members carry their own role (freelancer or client).
    const recipients = new Map<
      string,
      { email: string; role: WorkspaceMemberRole }
    >();
    recipients.set(workspace.owner.id, {
      email: workspace.owner.email,
      role: WorkspaceMemberRole.FREELANCER,
    });
    for (const member of workspace.members) {
      recipients.set(member.user.id, {
        email: member.user.email,
        role: member.role,
      });
    }
    recipients.delete(senderId);
    if (recipients.size === 0) return;

    const preview = this.truncate(content, PREVIEW_MAX_LENGTH);
    const heading = `New message in ${workspace.name}`;
    const body = `${senderName}: ${preview}`;

    for (const [userId, recipient] of recipients) {
      await this.prisma.notification.create({
        data: {
          userId,
          type: NotificationType.NEW_MESSAGE,
          workspaceId,
          data: { senderId, senderName, preview },
        },
      });

      // Online users will see it in-app via the bell; only email those away.
      if (this.presence.isOnline(userId)) continue;

      const path =
        recipient.role === WorkspaceMemberRole.CLIENT
          ? '/portal'
          : `/workspace/${workspaceId}`;
      try {
        await this.mail.sendNotificationEmail({
          to: recipient.email,
          heading,
          body,
          path,
          ctaLabel: 'View message',
        });
      } catch (error) {
        this.logger.error(
          `Failed to send notification email to ${recipient.email}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }

  private truncate(text: string, max: number): string {
    const trimmed = text.trim();
    return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
  }
}
