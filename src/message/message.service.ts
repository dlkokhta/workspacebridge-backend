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
}
