import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from './storage/storage.service';
import {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  FILE_SIZE_LIMITS,
  STORAGE_LIMITS,
} from './file.constants';

interface UploadParams {
  workspaceId: string;
  userId: string;
  userRole: UserRole;
  file: Express.Multer.File;
}

@Injectable()
export class FileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async list(workspaceId: string, userId: string, _userRole: UserRole) {
    await this.ensureWorkspaceAccess(workspaceId, userId);

    return this.prisma.file.findMany({
      where: { workspaceId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        mimeType: true,
        size: true,
        createdAt: true,
        updatedAt: true,
        uploadedBy: {
          select: { id: true, firstname: true, lastname: true, email: true },
        },
      },
    });
  }

  async upload({ workspaceId, userId, file }: UploadParams) {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    const { ownerId } = await this.ensureWorkspaceAccess(workspaceId, userId);

    const owner = await this.prisma.user.findUniqueOrThrow({
      where: { id: ownerId },
      select: { plan: true },
    });

    const ext = extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new BadRequestException(`File extension ${ext} is not allowed`);
    }

    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(`MIME type ${file.mimetype} is not allowed`);
    }

    const fileSizeLimit = FILE_SIZE_LIMITS[owner.plan];
    if (file.size > fileSizeLimit) {
      throw new PayloadTooLargeException(
        `File exceeds ${owner.plan} plan limit of ${this.formatBytes(fileSizeLimit)}`,
      );
    }

    const usage = await this.getWorkspaceUsage(workspaceId);
    const storageLimit = STORAGE_LIMITS[owner.plan];
    if (usage + file.size > storageLimit) {
      throw new PayloadTooLargeException(
        `Workspace storage limit of ${this.formatBytes(storageLimit)} would be exceeded`,
      );
    }

    const fileId = randomUUID();
    const storageKey = `workspaces/${workspaceId}/files/${fileId}${ext}`;

    await this.storage.upload(storageKey, file.buffer, file.mimetype);

    try {
      return await this.prisma.file.create({
        data: {
          id: fileId,
          workspaceId,
          uploadedById: userId,
          name: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          storageKey,
        },
        include: {
          uploadedBy: {
            select: { id: true, firstname: true, lastname: true, email: true },
          },
        },
      });
    } catch (error) {
      await this.storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
  }

  async getDownloadUrl(fileId: string, userId: string, _userRole: UserRole) {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: {
        id: true,
        name: true,
        storageKey: true,
        deletedAt: true,
        workspaceId: true,
      },
    });
    if (!file || file.deletedAt) {
      throw new NotFoundException('File not found');
    }
    await this.ensureWorkspaceAccess(file.workspaceId, userId);

    const url = await this.storage.getDownloadUrl(file.storageKey);
    return { url, expiresIn: 600, name: file.name };
  }

  async remove(fileId: string, userId: string, _userRole: UserRole) {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: {
        id: true,
        uploadedById: true,
        deletedAt: true,
        workspaceId: true,
        workspace: { select: { ownerId: true } },
      },
    });
    if (!file || file.deletedAt) {
      throw new NotFoundException('File not found');
    }

    const isUploader = file.uploadedById === userId;
    const isWorkspaceOwner = file.workspace.ownerId === userId;
    if (!isUploader && !isWorkspaceOwner) {
      throw new ForbiddenException(
        'Only the uploader or workspace owner can delete this file',
      );
    }

    return this.prisma.file.update({
      where: { id: fileId },
      data: { deletedAt: new Date() },
      select: { id: true, deletedAt: true },
    });
  }

  private async ensureWorkspaceAccess(
    workspaceId: string,
    userId: string,
  ): Promise<{ ownerId: string }> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        ownerId: true,
        members: { where: { userId }, select: { id: true } },
      },
    });
    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }
    const isOwner = workspace.ownerId === userId;
    const isMember = workspace.members.length > 0;
    if (!isOwner && !isMember) {
      throw new ForbiddenException('Not a workspace member');
    }
    return { ownerId: workspace.ownerId };
  }

  private async getWorkspaceUsage(workspaceId: string): Promise<number> {
    const result = await this.prisma.file.aggregate({
      where: { workspaceId, deletedAt: null },
      _sum: { size: true },
    });
    return result._sum.size ?? 0;
  }

  private formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / 1024 / 1024 / 1024).toFixed(0)} GB`;
    }
    return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  }
}
