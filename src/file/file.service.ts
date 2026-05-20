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
import { fromBuffer as detectFileType } from 'file-type';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from './storage/storage.service';
import {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  FILE_SIZE_LIMITS,
  MAX_FILENAME_LENGTH,
  STORAGE_LIMITS,
  TEXT_BASED_EXTENSIONS,
  TEXT_BASED_MIME_TYPES,
  TRASH_RETENTION_DAYS,
} from './file.constants';

const NULL_BYTE_SAMPLE_SIZE = 8192;

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

    const safeName = this.sanitizeFilename(file.originalname);
    const ext = extname(safeName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new BadRequestException(`File extension ${ext} is not allowed`);
    }

    const verifiedMimeType = await this.verifyMimeType(file, ext);

    const fileSizeLimit = FILE_SIZE_LIMITS[owner.plan];
    if (file.size > fileSizeLimit) {
      throw new PayloadTooLargeException(
        `File exceeds ${owner.plan} plan limit of ${this.formatBytes(fileSizeLimit)}`,
      );
    }

    const storageLimit = STORAGE_LIMITS[owner.plan];
    const preCheckUsage = await this.getWorkspaceUsage(workspaceId);
    if (preCheckUsage + file.size > storageLimit) {
      throw new PayloadTooLargeException(
        `Workspace storage limit of ${this.formatBytes(storageLimit)} would be exceeded`,
      );
    }

    const fileId = randomUUID();
    const storageKey = `workspaces/${workspaceId}/files/${fileId}${ext}`;

    await this.storage.upload(storageKey, file.buffer, verifiedMimeType);

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Per-workspace advisory lock: concurrent uploads to the same
        // workspace serialize here so the quota check sees a consistent
        // total. Different workspaces don't block each other.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`;

        // Re-check inside the lock so concurrent uploads can't both pass the
        // pre-check and race past the cap. Must mirror getWorkspaceUsage: also
        // count soft-deleted bytes still inside the trash retention window.
        const trashCutoff = new Date(
          Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000,
        );
        const { _sum } = await tx.file.aggregate({
          where: {
            workspaceId,
            OR: [{ deletedAt: null }, { deletedAt: { gte: trashCutoff } }],
          },
          _sum: { size: true },
        });
        const currentUsage = _sum.size ?? 0;
        if (currentUsage + file.size > storageLimit) {
          throw new PayloadTooLargeException(
            `Workspace storage limit of ${this.formatBytes(storageLimit)} would be exceeded`,
          );
        }

        return tx.file.create({
          data: {
            id: fileId,
            workspaceId,
            uploadedById: userId,
            name: safeName,
            mimeType: verifiedMimeType,
            size: file.size,
            storageKey,
          },
          include: {
            uploadedBy: {
              select: { id: true, firstname: true, lastname: true, email: true },
            },
          },
        });
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

  async listTrash(workspaceId: string, userId: string, _userRole: UserRole) {
    await this.ensureWorkspaceAccess(workspaceId, userId);

    const cutoff = new Date(
      Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    return this.prisma.file.findMany({
      where: {
        workspaceId,
        deletedAt: { not: null, gte: cutoff },
      },
      orderBy: { deletedAt: 'desc' },
      select: {
        id: true,
        name: true,
        mimeType: true,
        size: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
        uploadedBy: {
          select: { id: true, firstname: true, lastname: true, email: true },
        },
      },
    });
  }

  async restore(fileId: string, userId: string, _userRole: UserRole) {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: {
        id: true,
        size: true,
        uploadedById: true,
        deletedAt: true,
        workspaceId: true,
        workspace: { select: { ownerId: true } },
      },
    });
    if (!file || !file.deletedAt) {
      throw new NotFoundException('File not found');
    }

    const cutoff = new Date(
      Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    if (file.deletedAt < cutoff) {
      throw new NotFoundException('File not found');
    }

    const isUploader = file.uploadedById === userId;
    const isWorkspaceOwner = file.workspace.ownerId === userId;
    if (!isUploader && !isWorkspaceOwner) {
      throw new ForbiddenException(
        'Only the uploader or workspace owner can restore this file',
      );
    }

    const owner = await this.prisma.user.findUniqueOrThrow({
      where: { id: file.workspace.ownerId },
      select: { plan: true },
    });
    const storageLimit = STORAGE_LIMITS[owner.plan];

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${file.workspaceId}))`;

      // Count both active and soft-deleted-within-retention bytes — those are
      // physically present in R2 and count against the owner's quota. This
      // also means the file being restored (still soft-deleted at this point)
      // is already in the sum, so the check enforces that the workspace
      // could hold the file even if it stayed in trash forever.
      const trashCutoff = new Date(
        Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      );
      const { _sum } = await tx.file.aggregate({
        where: {
          workspaceId: file.workspaceId,
          OR: [{ deletedAt: null }, { deletedAt: { gte: trashCutoff } }],
        },
        _sum: { size: true },
      });
      const currentUsage = _sum.size ?? 0;
      if (currentUsage > storageLimit) {
        throw new PayloadTooLargeException(
          `Restoring this file would exceed the workspace storage limit of ${this.formatBytes(storageLimit)}`,
        );
      }

      return tx.file.update({
        where: { id: fileId },
        data: { deletedAt: null },
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
    });
  }

  /**
   * Permanently delete a soft-deleted file from trash. Frees R2 bytes
   * immediately so the user does not have to wait for the daily cleanup
   * sweep ({@link FileCleanupService}). Only the original uploader or the
   * workspace owner may purge.
   *
   * Order matches the cleanup cron: R2 first, then DB row. If R2 throws,
   * the DB row stays and the next sweep (or a retry) will pick it up.
   */
  async purge(fileId: string, userId: string, _userRole: UserRole) {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: {
        id: true,
        uploadedById: true,
        deletedAt: true,
        storageKey: true,
        workspace: { select: { ownerId: true } },
      },
    });
    if (!file || !file.deletedAt) {
      throw new NotFoundException('File not found');
    }

    const isUploader = file.uploadedById === userId;
    const isWorkspaceOwner = file.workspace.ownerId === userId;
    if (!isUploader && !isWorkspaceOwner) {
      throw new ForbiddenException(
        'Only the uploader or workspace owner can permanently delete this file',
      );
    }

    await this.storage.delete(file.storageKey);
    await this.prisma.file.delete({ where: { id: fileId } });

    return { id: fileId, purged: true };
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

  /**
   * Cleans the client-supplied filename before persisting it. We never trust
   * the raw value: it can carry control characters (log injection via `\n`),
   * null bytes that confuse downstream tools, or absurd lengths that break
   * the UI. The extension is preserved so display + downloads stay coherent.
   */
  private sanitizeFilename(originalName: string): string {
    // eslint-disable-next-line no-control-regex
    const stripped = originalName.replace(/[\x00-\x1F\x7F]/g, '');
    const trimmed = stripped.trim().replace(/[. ]+$/, '');
    if (!trimmed) {
      throw new BadRequestException('Filename is required');
    }
    if (trimmed.length <= MAX_FILENAME_LENGTH) {
      return trimmed;
    }
    const ext = extname(trimmed);
    const base = trimmed.slice(0, trimmed.length - ext.length);
    const truncatedBase = base.slice(0, MAX_FILENAME_LENGTH - ext.length);
    return truncatedBase + ext;
  }

  /**
   * Returns the MIME type to trust for this upload. Detected from the file's magic bytes
   * when possible — never from the client-supplied `Content-Type`, which can be spoofed.
   *
   * For text formats (.txt, .csv, .json, .svg, ...) `file-type` returns nothing because
   * they have no signature; we accept those only if the extension matches a known text type
   * AND the buffer has no null bytes in its head (rules out binary content masquerading as text).
   */
  private async verifyMimeType(
    file: Express.Multer.File,
    ext: string,
  ): Promise<string> {
    const detected = await detectFileType(file.buffer);

    if (detected) {
      if (!ALLOWED_MIME_TYPES.has(detected.mime)) {
        throw new BadRequestException(
          `File content type ${detected.mime} is not allowed`,
        );
      }
      return detected.mime;
    }

    if (!TEXT_BASED_EXTENSIONS.has(ext)) {
      throw new BadRequestException(
        'File content does not match any supported type',
      );
    }
    if (!TEXT_BASED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(
        `MIME type ${file.mimetype} is not allowed for ${ext}`,
      );
    }

    const sample = file.buffer.subarray(
      0,
      Math.min(NULL_BYTE_SAMPLE_SIZE, file.buffer.length),
    );
    if (sample.includes(0)) {
      throw new BadRequestException(
        'File appears to be binary but claims to be a text format',
      );
    }

    return file.mimetype;
  }

  /**
   * Workspace storage usage in bytes. Includes both active files and
   * soft-deleted files still within the trash retention window — those
   * bytes are physically present in R2 until the cleanup cron purges them,
   * so they must count against the owner's quota.
   */
  private async getWorkspaceUsage(workspaceId: string): Promise<number> {
    const cutoff = new Date(
      Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const result = await this.prisma.file.aggregate({
      where: {
        workspaceId,
        OR: [{ deletedAt: null }, { deletedAt: { gte: cutoff } }],
      },
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
