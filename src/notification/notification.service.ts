import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NotificationType, Prisma, WorkspaceMemberRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceService } from '../presence/presence.service';
import { MailService } from '../mail/mail.service';
import { NotificationGateway } from './notification.gateway';
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
    private readonly gateway: NotificationGateway,
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
   * arrived. An in-app notification is always created and pushed live; members
   * who are offline also get an email so they don't miss it.
   */
  async notifyNewMessage(params: {
    workspaceId: string;
    senderId: string;
    senderName: string;
    content: string;
  }): Promise<void> {
    const { workspaceId, senderId, senderName, content } = params;
    const resolved = await this.resolveRecipients(workspaceId, senderId);
    if (!resolved || resolved.recipients.size === 0) return;

    const preview = this.truncate(content, PREVIEW_MAX_LENGTH);
    await this.dispatch({
      workspaceId,
      recipients: resolved.recipients,
      type: NotificationType.NEW_MESSAGE,
      data: { senderId, senderName, preview },
      heading: `New message in ${resolved.workspaceName}`,
      body: `${senderName}: ${preview}`,
      ctaLabel: 'View message',
    });
  }

  /**
   * Notifies every workspace member except the commenter that a comment was
   * left on a file — same in-app + offline-email behaviour as messages.
   */
  async notifyFileComment(params: {
    fileId: string;
    commenterId: string;
    commenterName: string;
    body: string;
  }): Promise<void> {
    const { fileId, commenterId, commenterName, body } = params;

    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: { name: true, workspaceId: true },
    });
    if (!file) return;

    const resolved = await this.resolveRecipients(
      file.workspaceId,
      commenterId,
    );
    if (!resolved || resolved.recipients.size === 0) return;

    const preview = this.truncate(body, PREVIEW_MAX_LENGTH);
    await this.dispatch({
      workspaceId: file.workspaceId,
      recipients: resolved.recipients,
      type: NotificationType.FILE_COMMENT,
      data: { commenterId, commenterName, fileName: file.name, preview },
      heading: `New comment on ${file.name}`,
      body: `${commenterName}: ${preview}`,
      ctaLabel: 'View comment',
    });
  }

  // Everyone in the workspace, deduped, minus the excluded user. The owner is
  // the managing freelancer; members carry their own role.
  private async resolveRecipients(
    workspaceId: string,
    excludeUserId: string,
  ): Promise<{
    workspaceName: string;
    recipients: Map<string, { email: string; role: WorkspaceMemberRole }>;
  } | null> {
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
    if (!workspace) return null;

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
    recipients.delete(excludeUserId);

    return { workspaceName: workspace.name, recipients };
  }

  // Creates a notification row per recipient, pushes it live, and emails anyone
  // who is currently offline.
  private async dispatch(params: {
    workspaceId: string;
    recipients: Map<string, { email: string; role: WorkspaceMemberRole }>;
    type: NotificationType;
    data: Prisma.InputJsonValue;
    heading: string;
    body: string;
    ctaLabel: string;
  }): Promise<void> {
    const { workspaceId, recipients, type, data, heading, body, ctaLabel } =
      params;

    for (const [userId, recipient] of recipients) {
      const created = await this.prisma.notification.create({
        data: { userId, type, workspaceId, data },
        select: {
          id: true,
          type: true,
          data: true,
          isRead: true,
          createdAt: true,
          workspace: { select: { id: true, name: true } },
        },
      });

      // Push live to any open tab/device; offline rooms are empty no-ops.
      this.gateway.emitToUser(userId, created);

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
          ctaLabel,
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
