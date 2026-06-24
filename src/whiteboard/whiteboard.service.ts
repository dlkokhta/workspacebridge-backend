import {
  BadRequestException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WhiteboardGateway } from './whiteboard.gateway';
import { SaveWhiteboardDto } from './dto/save-whiteboard.dto';
import { CreateWhiteboardDto } from './dto/create-whiteboard.dto';
import { RenameWhiteboardDto } from './dto/rename-whiteboard.dto';

@Injectable()
export class WhiteboardService {
  constructor(
    private readonly prisma: PrismaService,
    // forwardRef: the gateway also depends on this service (direct cycle).
    @Inject(forwardRef(() => WhiteboardGateway))
    private readonly gateway: WhiteboardGateway,
  ) {}

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

  // Owner or member — used by the gateway to gate the workspace board-sync
  // room without needing the caller's role (which sockets don't carry).
  async canAccessWorkspace(
    workspaceId: string,
    userId: string,
  ): Promise<boolean> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { ownerId: true },
    });
    if (!workspace) return false;
    if (workspace.ownerId === userId) return true;

    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    return !!member;
  }

  // Returns the board's workspace id only when the user owns that workspace —
  // i.e. is the "presenter" whose board switches clients follow. Null otherwise,
  // so the gateway can derive the broadcast room server-side instead of
  // trusting a client-supplied workspace id.
  async ownedBoardWorkspaceId(
    boardId: string,
    userId: string,
  ): Promise<string | null> {
    const board = await this.prisma.whiteboard.findUnique({
      where: { id: boardId },
      select: { workspaceId: true, workspace: { select: { ownerId: true } } },
    });
    if (!board || board.workspace.ownerId !== userId) return null;
    return board.workspaceId;
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
    const elements = (dto.elements ?? []) as Prisma.InputJsonValue;
    const appState =
      dto.appState === undefined
        ? Prisma.JsonNull
        : (dto.appState as Prisma.InputJsonValue);
    const board = await this.prisma.whiteboard.create({
      data: {
        workspaceId,
        name: dto.name?.trim() || 'Untitled board',
        elements,
        appState,
      },
    });
    // Let other participants' tab bars pick up the new board live.
    this.gateway.broadcastBoardCreated(workspaceId, {
      id: board.id,
      name: board.name,
      updatedAt: board.updatedAt,
    });
    return board;
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

  async rename(boardId: string, userId: string, dto: RenameWhiteboardDto) {
    const allowed = await this.canAccessBoard(boardId, userId);
    if (!allowed) throw new ForbiddenException('Access denied');
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Name cannot be empty');
    const board = await this.prisma.whiteboard.update({
      where: { id: boardId },
      data: { name },
      select: { id: true, name: true, updatedAt: true, workspaceId: true },
    });
    this.gateway.broadcastBoardRenamed(board.workspaceId, {
      id: board.id,
      name: board.name,
      updatedAt: board.updatedAt,
    });
    return board;
  }

  async duplicate(boardId: string, userId: string) {
    const allowed = await this.canAccessBoard(boardId, userId);
    if (!allowed) throw new ForbiddenException('Access denied');
    const source = await this.prisma.whiteboard.findUnique({
      where: { id: boardId },
    });
    if (!source) throw new NotFoundException('Whiteboard not found');
    const board = await this.prisma.whiteboard.create({
      data: {
        workspaceId: source.workspaceId,
        name: `${source.name} (copy)`.slice(0, 100),
        elements: source.elements as Prisma.InputJsonValue,
        appState:
          source.appState === null
            ? Prisma.JsonNull
            : (source.appState as Prisma.InputJsonValue),
        files:
          source.files === null
            ? Prisma.JsonNull
            : (source.files as Prisma.InputJsonValue),
      },
      select: { id: true, name: true, updatedAt: true, createdAt: true },
    });
    this.gateway.broadcastBoardCreated(source.workspaceId, {
      id: board.id,
      name: board.name,
      updatedAt: board.updatedAt,
    });
    return board;
  }

  async delete(boardId: string, userId: string) {
    const board = await this.prisma.whiteboard.findUnique({
      where: { id: boardId },
      select: { workspace: { select: { id: true, ownerId: true } } },
    });
    if (!board) throw new NotFoundException('Whiteboard not found');
    if (board.workspace.ownerId !== userId)
      throw new ForbiddenException('Only the workspace owner can delete');
    await this.prisma.whiteboard.delete({ where: { id: boardId } });
    this.gateway.broadcastBoardDeleted(board.workspace.id, boardId);
    return { id: boardId };
  }
}
