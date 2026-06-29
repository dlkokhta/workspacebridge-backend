/* eslint-disable
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/unbound-method
*/
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { FileCommentService } from './file-comment.service';
import { FileGateway } from './file.gateway';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';

const mockPrismaService = {
  file: {
    findUnique: jest.fn(),
  },
  fileComment: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
  },
};

const mockNotificationService = {
  notifyFileComment: jest.fn().mockResolvedValue(undefined),
};

const mockFileGateway = {
  emitCommentCreated: jest.fn(),
  emitCommentDeleted: jest.fn(),
};

// Shape returned by FileCommentService.ensureFileAccess's findUnique: a live
// file whose workspace lists `userId` as a member.
const liveFileForMember = (userId: string, ownerId = 'owner-1') => ({
  deletedAt: null,
  workspaceId: 'ws-1',
  workspace: {
    ownerId,
    members: [{ id: 'member-1', userId }],
  },
});

describe('FileCommentService', () => {
  let service: FileCommentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FileCommentService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: NotificationService, useValue: mockNotificationService },
        { provide: FileGateway, useValue: mockFileGateway },
      ],
    }).compile();

    service = module.get<FileCommentService>(FileCommentService);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('persists the comment and broadcasts fileCommentCreated to the workspace', async () => {
      mockPrismaService.file.findUnique.mockResolvedValue(
        liveFileForMember('user-1'),
      );
      const created = {
        id: 'comment-1',
        fileId: 'file-1',
        body: 'Looks great',
        author: {
          id: 'user-1',
          firstname: 'Ada',
          lastname: 'Byron',
          email: 'ada@example.com',
          picture: null,
        },
      };
      mockPrismaService.fileComment.create.mockResolvedValue(created);

      const result = await service.create('file-1', 'user-1', {
        body: 'Looks great',
      });

      expect(result).toBe(created);
      expect(mockPrismaService.fileComment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { fileId: 'file-1', authorId: 'user-1', body: 'Looks great' },
        }),
      );
      // The new live-sync wiring: workspace id resolved from the file, full
      // comment forwarded so the other side can render it without a refetch.
      expect(mockFileGateway.emitCommentCreated).toHaveBeenCalledWith(
        'ws-1',
        created,
      );
    });

    it('trims the body before persisting and broadcasting', async () => {
      mockPrismaService.file.findUnique.mockResolvedValue(
        liveFileForMember('user-1'),
      );
      mockPrismaService.fileComment.create.mockResolvedValue({
        id: 'comment-1',
        fileId: 'file-1',
      });

      await service.create('file-1', 'user-1', { body: '  hi  ' });

      expect(mockPrismaService.fileComment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ body: 'hi' }),
        }),
      );
    });

    it('throws BadRequestException for a blank body and does not broadcast', async () => {
      mockPrismaService.file.findUnique.mockResolvedValue(
        liveFileForMember('user-1'),
      );

      await expect(
        service.create('file-1', 'user-1', { body: '   ' }),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrismaService.fileComment.create).not.toHaveBeenCalled();
      expect(mockFileGateway.emitCommentCreated).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException for a non-member and does not broadcast', async () => {
      mockPrismaService.file.findUnique.mockResolvedValue({
        deletedAt: null,
        workspaceId: 'ws-1',
        workspace: { ownerId: 'someone-else', members: [] },
      });

      await expect(
        service.create('file-1', 'user-1', { body: 'hi' }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockFileGateway.emitCommentCreated).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for a trashed file and does not broadcast', async () => {
      mockPrismaService.file.findUnique.mockResolvedValue({
        deletedAt: new Date(),
        workspaceId: 'ws-1',
        workspace: { ownerId: 'owner-1', members: [{ id: 'm1', userId: 'user-1' }] },
      });

      await expect(
        service.create('file-1', 'user-1', { body: 'hi' }),
      ).rejects.toThrow(NotFoundException);
      expect(mockFileGateway.emitCommentCreated).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    const commentByAuthor = (authorId: string, ownerId = 'owner-1') => ({
      id: 'comment-1',
      fileId: 'file-1',
      authorId,
      file: { workspaceId: 'ws-1', workspace: { ownerId } },
    });

    it('lets the author delete and broadcasts fileCommentDeleted with file + workspace ids', async () => {
      mockPrismaService.fileComment.findUnique.mockResolvedValue(
        commentByAuthor('user-1'),
      );
      mockPrismaService.fileComment.delete.mockResolvedValue({ id: 'comment-1' });

      const result = await service.delete('comment-1', 'user-1');

      expect(result).toEqual({ id: 'comment-1', deleted: true });
      expect(mockPrismaService.fileComment.delete).toHaveBeenCalledWith({
        where: { id: 'comment-1' },
      });
      expect(mockFileGateway.emitCommentDeleted).toHaveBeenCalledWith(
        'ws-1',
        'file-1',
        'comment-1',
      );
    });

    it('lets the workspace owner delete another user’s comment and broadcasts', async () => {
      mockPrismaService.fileComment.findUnique.mockResolvedValue(
        commentByAuthor('someone-else', 'owner-1'),
      );
      mockPrismaService.fileComment.delete.mockResolvedValue({ id: 'comment-1' });

      await service.delete('comment-1', 'owner-1');

      expect(mockFileGateway.emitCommentDeleted).toHaveBeenCalledWith(
        'ws-1',
        'file-1',
        'comment-1',
      );
    });

    it('throws ForbiddenException when caller is neither author nor owner, no broadcast', async () => {
      mockPrismaService.fileComment.findUnique.mockResolvedValue(
        commentByAuthor('someone-else', 'owner-1'),
      );

      await expect(service.delete('comment-1', 'intruder')).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockPrismaService.fileComment.delete).not.toHaveBeenCalled();
      expect(mockFileGateway.emitCommentDeleted).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for a missing comment and does not broadcast', async () => {
      mockPrismaService.fileComment.findUnique.mockResolvedValue(null);

      await expect(service.delete('missing', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockFileGateway.emitCommentDeleted).not.toHaveBeenCalled();
    });
  });
});
