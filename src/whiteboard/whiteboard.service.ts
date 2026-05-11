import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SaveWhiteboardDto } from './dto/save-whiteboard.dto';

@Injectable()
export class WhiteboardService {
  constructor(private readonly prisma: PrismaService) {}

  async canAccess(workspaceId: string, userId: string): Promise<boolean> {
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

  async assertAccess(workspaceId: string, userId: string, role: UserRole) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
    });

    if (!workspace) throw new NotFoundException('Workspace not found');

    if (role === UserRole.FREELANCER || role === UserRole.ADMIN) {
      if (workspace.ownerId !== userId)
        throw new ForbiddenException('Access denied');
      return;
    }

    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });

    if (!member) throw new ForbiddenException('Access denied');
  }

  async persist(
    workspaceId: string,
    payload: {
      elements: unknown[];
      appState?: Record<string, unknown>;
      files?: Record<string, unknown>;
    },
  ) {
    const appState =
      payload.appState === undefined
        ? Prisma.JsonNull
        : (payload.appState as Prisma.InputJsonValue);
    const files =
      payload.files === undefined
        ? Prisma.JsonNull
        : (payload.files as Prisma.InputJsonValue);

    return this.prisma.whiteboard.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        elements: payload.elements as Prisma.InputJsonValue,
        appState,
        files,
      },
      update: {
        elements: payload.elements as Prisma.InputJsonValue,
        appState,
        files,
      },
    });
  }

  async getOrCreate(workspaceId: string, userId: string, role: UserRole) {
    await this.assertAccess(workspaceId, userId, role);
    return this.getOrCreateForSocket(workspaceId);
  }

  async getOrCreateForSocket(workspaceId: string) {
    const existing = await this.prisma.whiteboard.findUnique({
      where: { workspaceId },
    });

    if (existing) return existing;

    return this.prisma.whiteboard.create({
      data: { workspaceId, elements: [] },
    });
  }

  async save(
    workspaceId: string,
    userId: string,
    role: UserRole,
    dto: SaveWhiteboardDto,
  ) {
    await this.assertAccess(workspaceId, userId, role);
    return this.persist(workspaceId, dto);
  }
}
