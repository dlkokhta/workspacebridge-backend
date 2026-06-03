import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const senderSelect = {
  id: true,
  firstname: true,
  lastname: true,
  email: true,
  picture: true,
} as const;

@Injectable()
export class MessageService {
  constructor(private readonly prisma: PrismaService) {}

  async isWorkspaceMember(workspaceId: string, userId: string): Promise<boolean> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
    });

    if (!workspace) return false;
    if (workspace.ownerId === userId) return true;

    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });

    return !!member;
  }

  async saveMessage(workspaceId: string, senderId: string, content: string) {
    return this.prisma.message.create({
      data: { workspaceId, senderId, content },
      include: { sender: { select: senderSelect } },
    });
  }

  async getMessages(workspaceId: string, limit = 50, cursor?: string) {
    const messages = await this.prisma.message.findMany({
      where: { workspaceId },
      include: { sender: { select: senderSelect } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });

    return {
      messages: messages.reverse(),
      hasMore: messages.length === limit,
    };
  }

  /**
   * Records that `userId` has read this workspace's chat up to now. Returns the
   * timestamp so the gateway can broadcast it to the other participants.
   */
  async markRead(workspaceId: string, userId: string): Promise<Date> {
    const lastReadAt = new Date();
    await this.prisma.chatRead.upsert({
      where: { workspaceId_userId: { workspaceId, userId } },
      create: { workspaceId, userId, lastReadAt },
      update: { lastReadAt },
    });
    return lastReadAt;
  }

  /**
   * Read positions of everyone in the workspace except the requester — sent on
   * join so a sender immediately sees how far others have read their messages.
   */
  async getReadState(workspaceId: string, exceptUserId: string) {
    return this.prisma.chatRead.findMany({
      where: { workspaceId, userId: { not: exceptUserId } },
      select: { userId: true, lastReadAt: true },
    });
  }
}
