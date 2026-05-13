import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WhiteboardService } from './whiteboard.service';
import { CreateWhiteboardCommentDto } from './dto/create-whiteboard-comment.dto';

const AUTHOR_SELECT = {
  id: true,
  firstname: true,
  lastname: true,
  email: true,
  picture: true,
} as const;

@Injectable()
export class WhiteboardCommentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly whiteboardService: WhiteboardService,
  ) {}

  async list(boardId: string, userId: string) {
    const allowed = await this.whiteboardService.canAccessBoard(
      boardId,
      userId,
    );
    if (!allowed) throw new ForbiddenException('Access denied');
    return this.prisma.whiteboardComment.findMany({
      where: { whiteboardId: boardId },
      orderBy: { createdAt: 'asc' },
      include: { author: { select: AUTHOR_SELECT } },
    });
  }

  async create(
    boardId: string,
    userId: string,
    dto: CreateWhiteboardCommentDto,
  ) {
    const allowed = await this.whiteboardService.canAccessBoard(
      boardId,
      userId,
    );
    if (!allowed) throw new ForbiddenException('Access denied');
    const body = dto.body.trim();
    if (!body) throw new BadRequestException('Comment body cannot be empty');
    return this.prisma.whiteboardComment.create({
      data: {
        whiteboardId: boardId,
        elementId: dto.elementId,
        authorId: userId,
        body,
      },
      include: { author: { select: AUTHOR_SELECT } },
    });
  }

  async delete(commentId: string, userId: string) {
    const comment = await this.prisma.whiteboardComment.findUnique({
      where: { id: commentId },
      select: { id: true, authorId: true, whiteboardId: true },
    });
    if (!comment) throw new NotFoundException('Comment not found');
    if (comment.authorId !== userId) {
      throw new ForbiddenException('Only the author can delete this comment');
    }
    await this.prisma.whiteboardComment.delete({ where: { id: commentId } });
    return { id: comment.id, whiteboardId: comment.whiteboardId };
  }
}
