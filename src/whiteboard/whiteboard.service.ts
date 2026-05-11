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

  async getOrCreate(workspaceId: string, userId: string, role: UserRole) {
    await this.assertAccess(workspaceId, userId, role);

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

    const appState =
      dto.appState === undefined
        ? Prisma.JsonNull
        : (dto.appState as Prisma.InputJsonValue);

    return this.prisma.whiteboard.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        elements: dto.elements as Prisma.InputJsonValue,
        appState,
      },
      update: {
        elements: dto.elements as Prisma.InputJsonValue,
        appState,
      },
    });
  }
}
