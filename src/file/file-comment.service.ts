import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';
import { FileGateway } from './file.gateway';
import { CreateFileCommentDto } from './dto/create-file-comment.dto';

const AUTHOR_SELECT = {
  id: true,
  firstname: true,
  lastname: true,
  email: true,
  picture: true,
} as const;

@Injectable()
export class FileCommentService {
  private readonly logger = new Logger(FileCommentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly gateway: FileGateway,
  ) {}

  async list(fileId: string, userId: string) {
    await this.ensureFileAccess(fileId, userId);

    return this.prisma.fileComment.findMany({
      where: { fileId },
      orderBy: { createdAt: 'asc' },
      include: { author: { select: AUTHOR_SELECT } },
    });
  }

  async create(fileId: string, userId: string, dto: CreateFileCommentDto) {
    const { workspaceId } = await this.ensureFileAccess(fileId, userId);

    const body = dto.body.trim();
    if (!body) {
      throw new BadRequestException('Comment body cannot be empty');
    }

    const created = await this.prisma.fileComment.create({
      data: { fileId, authorId: userId, body },
      include: { author: { select: AUTHOR_SELECT } },
    });

    const commenterName =
      `${created.author?.firstname ?? ''} ${created.author?.lastname ?? ''}`.trim() ||
      (created.author?.email ?? 'Someone');

    // Fire-and-forget: notification delivery must never block or fail commenting.
    void this.notifications
      .notifyFileComment({ fileId, commenterId: userId, commenterName, body })
      .catch((error: unknown) => {
        this.logger.error(
          'Failed to dispatch file comment notifications',
          error instanceof Error ? error.stack : undefined,
        );
      });

    this.gateway.emitCommentCreated(workspaceId, created);
    return created;
  }

  async delete(commentId: string, userId: string) {
    const comment = await this.prisma.fileComment.findUnique({
      where: { id: commentId },
      select: {
        id: true,
        fileId: true,
        authorId: true,
        file: {
          select: {
            workspaceId: true,
            workspace: { select: { ownerId: true } },
          },
        },
      },
    });
    if (!comment) {
      throw new NotFoundException('Comment not found');
    }

    const isAuthor = comment.authorId === userId;
    const isWorkspaceOwner = comment.file.workspace.ownerId === userId;
    if (!isAuthor && !isWorkspaceOwner) {
      throw new ForbiddenException(
        'Only the author or workspace owner can delete this comment',
      );
    }

    await this.prisma.fileComment.delete({ where: { id: commentId } });
    this.gateway.emitCommentDeleted(
      comment.file.workspaceId,
      comment.fileId,
      commentId,
    );
    return { id: commentId, deleted: true };
  }

  // Comments are scoped to a live (non-trashed) file; access follows the file's
  // workspace membership, mirroring FileService.ensureWorkspaceAccess.
  private async ensureFileAccess(
    fileId: string,
    userId: string,
  ): Promise<{ ownerId: string; workspaceId: string }> {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: {
        deletedAt: true,
        workspaceId: true,
        workspace: {
          select: {
            ownerId: true,
            members: { where: { userId }, select: { id: true } },
          },
        },
      },
    });
    if (!file || file.deletedAt) {
      throw new NotFoundException('File not found');
    }

    const isOwner = file.workspace.ownerId === userId;
    const isMember = file.workspace.members.length > 0;
    if (!isOwner && !isMember) {
      throw new ForbiddenException('Not a workspace member');
    }
    return { ownerId: file.workspace.ownerId, workspaceId: file.workspaceId };
  }
}
