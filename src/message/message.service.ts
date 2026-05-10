import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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
      include: {
        sender: {
          select: { id: true, firstname: true, lastname: true, email: true, picture: true },
        },
      },
    });
  }

  async getMessages(workspaceId: string, limit = 50) {
    const messages = await this.prisma.message.findMany({
      where: { workspaceId },
      include: {
        sender: {
          select: { id: true, firstname: true, lastname: true, email: true, picture: true },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    return messages;
  }
}
