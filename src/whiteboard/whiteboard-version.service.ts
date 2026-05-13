import {
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, WhiteboardVersionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WhiteboardService } from './whiteboard.service';
import { WhiteboardGateway } from './whiteboard.gateway';
import { CreateWhiteboardVersionDto } from './dto/create-whiteboard-version.dto';

const AUTHOR_SELECT = {
  id: true,
  firstname: true,
  lastname: true,
  email: true,
  picture: true,
} as const;

const SUMMARY_SELECT = {
  id: true,
  whiteboardId: true,
  label: true,
  type: true,
  createdAt: true,
  createdBy: { select: AUTHOR_SELECT },
} as const;

@Injectable()
export class WhiteboardVersionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly whiteboardService: WhiteboardService,
    @Inject(forwardRef(() => WhiteboardGateway))
    private readonly gateway: WhiteboardGateway,
  ) {}

  async list(boardId: string, userId: string) {
    const allowed = await this.whiteboardService.canAccessBoard(
      boardId,
      userId,
    );
    if (!allowed) throw new ForbiddenException('Access denied');
    return this.prisma.whiteboardVersion.findMany({
      where: { whiteboardId: boardId },
      orderBy: { createdAt: 'desc' },
      select: SUMMARY_SELECT,
    });
  }

  async getById(versionId: string, userId: string) {
    const version = await this.prisma.whiteboardVersion.findUnique({
      where: { id: versionId },
      include: { createdBy: { select: AUTHOR_SELECT } },
    });
    if (!version) throw new NotFoundException('Version not found');
    const allowed = await this.whiteboardService.canAccessBoard(
      version.whiteboardId,
      userId,
    );
    if (!allowed) throw new ForbiddenException('Access denied');
    return version;
  }

  async create(
    boardId: string,
    userId: string,
    dto: CreateWhiteboardVersionDto,
  ) {
    const allowed = await this.whiteboardService.canAccessBoard(
      boardId,
      userId,
    );
    if (!allowed) throw new ForbiddenException('Access denied');
    return this.prisma.whiteboardVersion.create({
      data: {
        whiteboardId: boardId,
        createdById: userId,
        elements: (dto.elements ?? []) as Prisma.InputJsonValue,
        appState:
          dto.appState === undefined
            ? Prisma.JsonNull
            : (dto.appState as Prisma.InputJsonValue),
        files:
          dto.files === undefined
            ? Prisma.JsonNull
            : (dto.files as Prisma.InputJsonValue),
        label: dto.label?.trim() || null,
        type: WhiteboardVersionType.MANUAL,
      },
      select: SUMMARY_SELECT,
    });
  }

  async restore(versionId: string, userId: string) {
    const version = await this.prisma.whiteboardVersion.findUnique({
      where: { id: versionId },
    });
    if (!version) throw new NotFoundException('Version not found');
    const allowed = await this.whiteboardService.canAccessBoard(
      version.whiteboardId,
      userId,
    );
    if (!allowed) throw new ForbiddenException('Access denied');

    const current = await this.prisma.whiteboard.findUnique({
      where: { id: version.whiteboardId },
    });
    if (!current) throw new NotFoundException('Whiteboard not found');

    const safetyLabel = version.label?.trim()
      ? `Before restoring "${version.label.trim()}"`
      : `Before restoring snapshot from ${version.createdAt.toISOString()}`;

    await this.prisma.whiteboardVersion.create({
      data: {
        whiteboardId: current.id,
        createdById: userId,
        elements: current.elements as Prisma.InputJsonValue,
        appState:
          current.appState === null
            ? Prisma.JsonNull
            : (current.appState as Prisma.InputJsonValue),
        files:
          current.files === null
            ? Prisma.JsonNull
            : (current.files as Prisma.InputJsonValue),
        label: safetyLabel,
        type: WhiteboardVersionType.AUTO,
      },
    });

    const restored = await this.prisma.whiteboard.update({
      where: { id: current.id },
      data: {
        elements: version.elements as Prisma.InputJsonValue,
        appState:
          version.appState === null
            ? Prisma.JsonNull
            : (version.appState as Prisma.InputJsonValue),
        files:
          version.files === null
            ? Prisma.JsonNull
            : (version.files as Prisma.InputJsonValue),
      },
    });

    this.gateway.broadcastBoardRestored(current.id, {
      elements: restored.elements,
      appState: restored.appState,
      files: restored.files,
    });

    return restored;
  }
}
