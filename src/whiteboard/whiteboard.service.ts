import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SaveWhiteboardDto } from './dto/save-whiteboard.dto';
import { CreateWhiteboardDto } from './dto/create-whiteboard.dto';

@Injectable()
export class WhiteboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getUserName(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { firstname: true, lastname: true },
    });
  }

  async assertWorkspaceAccess(
    workspaceId: string,
    userId: string,
    role: UserRole,
  ) {
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

  async canAccessBoard(boardId: string, userId: string): Promise<boolean> {
    const board = await this.prisma.whiteboard.findUnique({
      where: { id: boardId },
      select: { workspace: { select: { id: true, ownerId: true } } },
    });

    if (!board) return false;
    if (board.workspace.ownerId === userId) return true;

    const member = await this.prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: board.workspace.id, userId },
      },
    });

    return !!member;
  }

  async list(workspaceId: string, userId: string, role: UserRole) {
    await this.assertWorkspaceAccess(workspaceId, userId, role);
    return this.prisma.whiteboard.findMany({
      where: { workspaceId },
      select: { id: true, name: true, updatedAt: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(
    workspaceId: string,
    userId: string,
    role: UserRole,
    dto: CreateWhiteboardDto,
  ) {
    await this.assertWorkspaceAccess(workspaceId, userId, role);
    return this.prisma.whiteboard.create({
      data: {
        workspaceId,
        name: dto.name?.trim() || 'Untitled board',
        elements: [],
      },
    });
  }

  async getByIdForSocket(boardId: string) {
    return this.prisma.whiteboard.findUnique({ where: { id: boardId } });
  }

  async getById(boardId: string, userId: string) {
    const allowed = await this.canAccessBoard(boardId, userId);
    if (!allowed) throw new ForbiddenException('Access denied');
    const board = await this.prisma.whiteboard.findUnique({
      where: { id: boardId },
    });
    if (!board) throw new NotFoundException('Whiteboard not found');
    return board;
  }

  async persist(
    boardId: string,
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

    return this.prisma.whiteboard.update({
      where: { id: boardId },
      data: {
        elements: payload.elements as Prisma.InputJsonValue,
        appState,
        files,
      },
    });
  }

  async save(boardId: string, userId: string, dto: SaveWhiteboardDto) {
    const allowed = await this.canAccessBoard(boardId, userId);
    if (!allowed) throw new ForbiddenException('Access denied');
    return this.persist(boardId, dto);
  }
}
