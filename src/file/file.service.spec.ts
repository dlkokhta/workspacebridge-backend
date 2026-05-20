import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { UserPlan, UserRole } from '@prisma/client';
import { FileService } from './file.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from './storage/storage.service';
import { FILE_SIZE_LIMITS, STORAGE_LIMITS } from './file.constants';

jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomUUID: jest.fn(() => 'file-uuid-123'),
}));

jest.mock('file-type', () => ({
  fromBuffer: jest.fn(),
}));

import { fromBuffer as detectFileType } from 'file-type';
const mockedDetectFileType = detectFileType as jest.MockedFunction<
  typeof detectFileType
>;

const mockPrismaService = {
  workspace: {
    findUnique: jest.fn(),
  },
  user: {
    findUniqueOrThrow: jest.fn(),
  },
  file: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    aggregate: jest.fn(),
  },
  $transaction: jest.fn(),
  $executeRaw: jest.fn(),
};

/**
 * Default $transaction mock: invokes the callback with a tx object whose
 * methods delegate back to the top-level mockPrismaService. Individual tests
 * can override usage values per call by re-mocking `file.aggregate`.
 */
const defaultTransactionImpl = async <T>(
  cb: (tx: typeof mockPrismaService) => Promise<T>,
): Promise<T> => cb(mockPrismaService);

const mockStorageService: jest.Mocked<StorageService> = {
  upload: jest.fn(),
  getDownloadUrl: jest.fn(),
  delete: jest.fn(),
};

const buildMulterFile = (
  overrides: Partial<Express.Multer.File> = {},
): Express.Multer.File =>
  ({
    fieldname: 'file',
    originalname: 'report.pdf',
    encoding: '7bit',
    mimetype: 'application/pdf',
    size: 1024,
    buffer: Buffer.from('hello'),
    stream: undefined,
    destination: '',
    filename: '',
    path: '',
    ...overrides,
  }) as unknown as Express.Multer.File;

const workspaceWithMember = (userId: string, ownerId = 'owner-1') => ({
  ownerId,
  members: [{ id: 'member-1', userId }],
});

const workspaceOwnedBy = (ownerId: string) => ({
  ownerId,
  members: [],
});

describe('FileService', () => {
  let service: FileService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FileService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: StorageService, useValue: mockStorageService },
      ],
    }).compile();

    service = module.get<FileService>(FileService);

    jest.clearAllMocks();
  });

  // ─── list ───────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns files when caller is a workspace member', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue(
        workspaceWithMember('user-1'),
      );
      const files = [
        { id: 'f1', name: 'a.pdf', size: 10, mimeType: 'application/pdf' },
      ];
      mockPrismaService.file.findMany.mockResolvedValue(files);

      const result = await service.list('ws-1', 'user-1', UserRole.CLIENT);

      expect(mockPrismaService.workspace.findUnique).toHaveBeenCalledWith({
        where: { id: 'ws-1' },
        select: {
          ownerId: true,
          members: { where: { userId: 'user-1' }, select: { id: true } },
        },
      });
      expect(mockPrismaService.file.findMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1', deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: expect.objectContaining({
          id: true,
          name: true,
          mimeType: true,
          size: true,
        }),
      });
      expect(result).toEqual(files);
    });

    it('returns files when caller is the workspace owner', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue(
        workspaceOwnedBy('owner-1'),
      );
      mockPrismaService.file.findMany.mockResolvedValue([]);

      await expect(
        service.list('ws-1', 'owner-1', UserRole.FREELANCER),
      ).resolves.toEqual([]);
    });

    it('throws NotFoundException when workspace does not exist', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue(null);

      await expect(
        service.list('ws-missing', 'user-1', UserRole.CLIENT),
      ).rejects.toThrow(NotFoundException);
      expect(mockPrismaService.file.findMany).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when caller is not a member or owner', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue({
        ownerId: 'someone-else',
        members: [],
      });

      await expect(
        service.list('ws-1', 'user-1', UserRole.CLIENT),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrismaService.file.findMany).not.toHaveBeenCalled();
    });
  });

  // ─── upload ─────────────────────────────────────────────────────────────────

  describe('upload', () => {
    const baseParams = {
      workspaceId: 'ws-1',
      userId: 'user-1',
      userRole: UserRole.FREELANCER,
    };

    const setupHappyPath = () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue(
        workspaceWithMember('user-1', 'owner-1'),
      );
      mockPrismaService.user.findUniqueOrThrow.mockResolvedValue({
        plan: UserPlan.FREE,
      });
      mockPrismaService.file.aggregate.mockResolvedValue({ _sum: { size: 0 } });
      mockStorageService.upload.mockResolvedValue(undefined);
      mockStorageService.delete.mockResolvedValue(undefined);
      mockPrismaService.file.create.mockResolvedValue({
        id: 'file-uuid-123',
        name: 'report.pdf',
      });
      mockPrismaService.$executeRaw.mockResolvedValue(1);
      mockPrismaService.$transaction.mockImplementation(defaultTransactionImpl);
      mockedDetectFileType.mockResolvedValue({
        ext: 'pdf',
        mime: 'application/pdf',
      } as unknown as Awaited<ReturnType<typeof detectFileType>>);
    };

    it('throws BadRequestException when file is missing', async () => {
      await expect(
        service.upload({
          ...baseParams,
          file: undefined as unknown as Express.Multer.File,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws ForbiddenException when caller is not a workspace member', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue({
        ownerId: 'someone-else',
        members: [],
      });

      await expect(
        service.upload({ ...baseParams, file: buildMulterFile() }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException when extension is not allowed', async () => {
      setupHappyPath();

      await expect(
        service.upload({
          ...baseParams,
          file: buildMulterFile({
            originalname: 'shady.exe',
            mimetype: 'application/pdf',
          }),
        }),
      ).rejects.toThrow(/extension .* is not allowed/);
      expect(mockStorageService.upload).not.toHaveBeenCalled();
    });

    it('rejects spoofed Content-Type: detected MIME from bytes is what counts', async () => {
      setupHappyPath();
      mockedDetectFileType.mockResolvedValue({
        ext: 'exe',
        mime: 'application/x-msdownload',
      } as unknown as Awaited<ReturnType<typeof detectFileType>>);

      await expect(
        service.upload({
          ...baseParams,
          file: buildMulterFile({
            originalname: 'evil.pdf',
            mimetype: 'application/pdf',
          }),
        }),
      ).rejects.toThrow(/content type .* is not allowed/);
      expect(mockStorageService.upload).not.toHaveBeenCalled();
    });

    it('stores the detected MIME type, not the client-supplied one', async () => {
      setupHappyPath();
      mockedDetectFileType.mockResolvedValue({
        ext: 'png',
        mime: 'image/png',
      } as unknown as Awaited<ReturnType<typeof detectFileType>>);

      await service.upload({
        ...baseParams,
        file: buildMulterFile({
          originalname: 'photo.png',
          mimetype: 'application/octet-stream',
        }),
      });

      expect(mockPrismaService.file.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ mimeType: 'image/png' }),
        }),
      );
    });

    it('accepts text formats when detection returns nothing and buffer has no null bytes', async () => {
      setupHappyPath();
      mockedDetectFileType.mockResolvedValue(undefined);

      await service.upload({
        ...baseParams,
        file: buildMulterFile({
          originalname: 'notes.txt',
          mimetype: 'text/plain',
          buffer: Buffer.from('plain text content, no nulls here'),
        }),
      });

      expect(mockPrismaService.file.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ mimeType: 'text/plain' }),
        }),
      );
    });

    it('rejects binary content masquerading as a text format', async () => {
      setupHappyPath();
      mockedDetectFileType.mockResolvedValue(undefined);

      await expect(
        service.upload({
          ...baseParams,
          file: buildMulterFile({
            originalname: 'sneaky.txt',
            mimetype: 'text/plain',
            buffer: Buffer.from([0x48, 0x00, 0x49]),
          }),
        }),
      ).rejects.toThrow(/binary but claims to be a text format/);
    });

    it('rejects undetectable binary files (non-text extension, no signature)', async () => {
      setupHappyPath();
      mockedDetectFileType.mockResolvedValue(undefined);

      await expect(
        service.upload({
          ...baseParams,
          file: buildMulterFile({
            originalname: 'shady.pdf',
            mimetype: 'application/pdf',
          }),
        }),
      ).rejects.toThrow(/content does not match any supported type/);
    });

    it('throws PayloadTooLargeException when file exceeds plan size limit', async () => {
      setupHappyPath();

      await expect(
        service.upload({
          ...baseParams,
          file: buildMulterFile({ size: FILE_SIZE_LIMITS.FREE + 1 }),
        }),
      ).rejects.toThrow(PayloadTooLargeException);
      expect(mockStorageService.upload).not.toHaveBeenCalled();
    });

    it('throws PayloadTooLargeException when workspace storage limit would be exceeded (pre-check)', async () => {
      setupHappyPath();
      mockPrismaService.file.aggregate.mockResolvedValue({
        _sum: { size: STORAGE_LIMITS.FREE - 100 },
      });

      await expect(
        service.upload({
          ...baseParams,
          file: buildMulterFile({ size: 200 }),
        }),
      ).rejects.toThrow(PayloadTooLargeException);
      expect(mockStorageService.upload).not.toHaveBeenCalled();
    });

    it('pre-check counts soft-deleted bytes within retention towards the quota', async () => {
      setupHappyPath();

      await service.upload({ ...baseParams, file: buildMulterFile() });

      const preCheckCall = mockPrismaService.file.aggregate.mock.calls[0][0];
      expect(preCheckCall.where).toEqual(
        expect.objectContaining({
          workspaceId: 'ws-1',
          OR: expect.arrayContaining([
            { deletedAt: null },
            expect.objectContaining({
              deletedAt: expect.objectContaining({ gte: expect.any(Date) }),
            }),
          ]),
        }),
      );
    });

    it('locked re-check counts soft-deleted bytes within retention towards the quota', async () => {
      setupHappyPath();

      await service.upload({ ...baseParams, file: buildMulterFile() });

      // The 2nd aggregate call is the in-transaction re-check.
      const inTxCall = mockPrismaService.file.aggregate.mock.calls[1][0];
      expect(inTxCall.where).toEqual(
        expect.objectContaining({
          workspaceId: 'ws-1',
          OR: expect.arrayContaining([
            { deletedAt: null },
            expect.objectContaining({
              deletedAt: expect.objectContaining({ gte: expect.any(Date) }),
            }),
          ]),
        }),
      );
    });

    it('takes a per-workspace advisory lock inside the transaction', async () => {
      setupHappyPath();

      await service.upload({ ...baseParams, file: buildMulterFile() });

      expect(mockPrismaService.$executeRaw).toHaveBeenCalledTimes(1);
      const [strings, ...values] = mockPrismaService.$executeRaw.mock.calls[0];
      expect((strings as string[]).join('?')).toContain('pg_advisory_xact_lock');
      expect(values).toContain('ws-1');
    });

    it('rejects in the locked re-check when a concurrent upload filled the workspace', async () => {
      setupHappyPath();
      // Pre-check sees the workspace empty…
      mockPrismaService.file.aggregate
        .mockResolvedValueOnce({ _sum: { size: 0 } })
        // …but inside the locked TX a concurrent upload has filled it.
        .mockResolvedValueOnce({
          _sum: { size: STORAGE_LIMITS.FREE - 100 },
        });

      await expect(
        service.upload({
          ...baseParams,
          file: buildMulterFile({ size: 200 }),
        }),
      ).rejects.toThrow(PayloadTooLargeException);

      // R2 upload happened (pre-check passed), and we must clean it up.
      expect(mockStorageService.upload).toHaveBeenCalledTimes(1);
      expect(mockStorageService.delete).toHaveBeenCalledWith(
        'workspaces/ws-1/files/file-uuid-123.pdf',
      );
      expect(mockPrismaService.file.create).not.toHaveBeenCalled();
    });

    it('uploads the file, stores the object, and creates the DB record', async () => {
      setupHappyPath();

      await service.upload({
        ...baseParams,
        file: buildMulterFile({
          originalname: 'Report Final.PDF',
          size: 2048,
        }),
      });

      expect(mockStorageService.upload).toHaveBeenCalledWith(
        'workspaces/ws-1/files/file-uuid-123.pdf',
        expect.any(Buffer),
        'application/pdf',
      );
      expect(mockPrismaService.file.create).toHaveBeenCalledWith({
        data: {
          id: 'file-uuid-123',
          workspaceId: 'ws-1',
          uploadedById: 'user-1',
          name: 'Report Final.PDF',
          mimeType: 'application/pdf',
          size: 2048,
          storageKey: 'workspaces/ws-1/files/file-uuid-123.pdf',
        },
        include: {
          uploadedBy: {
            select: { id: true, firstname: true, lastname: true, email: true },
          },
        },
      });
    });

    it('enforces the workspace owner plan, not the uploader plan', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue(
        workspaceWithMember('user-1', 'owner-1'),
      );
      mockPrismaService.user.findUniqueOrThrow.mockResolvedValue({
        plan: UserPlan.FREE,
      });
      mockPrismaService.file.aggregate.mockResolvedValue({ _sum: { size: 0 } });

      await expect(
        service.upload({
          ...baseParams,
          file: buildMulterFile({ size: FILE_SIZE_LIMITS.PRO }),
        }),
      ).rejects.toThrow(PayloadTooLargeException);

      expect(mockPrismaService.user.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 'owner-1' },
        select: { plan: true },
      });
    });

    it('rolls back storage when DB create fails', async () => {
      setupHappyPath();
      const dbError = new Error('db down');
      mockPrismaService.file.create.mockRejectedValue(dbError);
      mockStorageService.delete.mockResolvedValue(undefined);

      await expect(
        service.upload({ ...baseParams, file: buildMulterFile() }),
      ).rejects.toBe(dbError);

      expect(mockStorageService.delete).toHaveBeenCalledWith(
        'workspaces/ws-1/files/file-uuid-123.pdf',
      );
    });

    it('still rejects with the original error when storage cleanup also fails', async () => {
      setupHappyPath();
      const dbError = new Error('db down');
      mockPrismaService.file.create.mockRejectedValue(dbError);
      mockStorageService.delete.mockRejectedValue(new Error('storage down'));

      await expect(
        service.upload({ ...baseParams, file: buildMulterFile() }),
      ).rejects.toBe(dbError);
    });
  });

  // ─── getDownloadUrl ─────────────────────────────────────────────────────────

  describe('getDownloadUrl', () => {
    it('returns a presigned URL with expiry and file name', async () => {
      mockPrismaService.file.findUnique.mockResolvedValue({
        id: 'file-1',
        name: 'report.pdf',
        storageKey: 'workspaces/ws-1/files/file-1.pdf',
        deletedAt: null,
        workspaceId: 'ws-1',
      });
      mockPrismaService.workspace.findUnique.mockResolvedValue(
        workspaceWithMember('user-1'),
      );
      mockStorageService.getDownloadUrl.mockResolvedValue(
        'https://signed.example/report.pdf?sig=abc',
      );

      const result = await service.getDownloadUrl(
        'file-1',
        'user-1',
        UserRole.CLIENT,
      );

      expect(mockStorageService.getDownloadUrl).toHaveBeenCalledWith(
        'workspaces/ws-1/files/file-1.pdf',
      );
      expect(result).toEqual({
        url: 'https://signed.example/report.pdf?sig=abc',
        expiresIn: 600,
        name: 'report.pdf',
      });
    });

    it('throws NotFoundException when the file does not exist', async () => {
      mockPrismaService.file.findUnique.mockResolvedValue(null);

      await expect(
        service.getDownloadUrl('missing', 'user-1', UserRole.CLIENT),
      ).rejects.toThrow(NotFoundException);
      expect(mockStorageService.getDownloadUrl).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the file is soft-deleted', async () => {
      mockPrismaService.file.findUnique.mockResolvedValue({
        id: 'file-1',
        name: 'report.pdf',
        storageKey: 'workspaces/ws-1/files/file-1.pdf',
        deletedAt: new Date(),
        workspaceId: 'ws-1',
      });

      await expect(
        service.getDownloadUrl('file-1', 'user-1', UserRole.CLIENT),
      ).rejects.toThrow(NotFoundException);
      expect(mockStorageService.getDownloadUrl).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when caller is not a workspace member', async () => {
      mockPrismaService.file.findUnique.mockResolvedValue({
        id: 'file-1',
        name: 'report.pdf',
        storageKey: 'workspaces/ws-1/files/file-1.pdf',
        deletedAt: null,
        workspaceId: 'ws-1',
      });
      mockPrismaService.workspace.findUnique.mockResolvedValue({
        ownerId: 'someone-else',
        members: [],
      });

      await expect(
        service.getDownloadUrl('file-1', 'user-1', UserRole.CLIENT),
      ).rejects.toThrow(ForbiddenException);
      expect(mockStorageService.getDownloadUrl).not.toHaveBeenCalled();
    });
  });

  // ─── remove ─────────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('throws NotFoundException when the file does not exist', async () => {
      mockPrismaService.file.findUnique.mockResolvedValue(null);

      await expect(
        service.remove('missing', 'user-1', UserRole.CLIENT),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when the file is already soft-deleted', async () => {
      mockPrismaService.file.findUnique.mockResolvedValue({
        id: 'file-1',
        uploadedById: 'user-1',
        deletedAt: new Date(),
        workspaceId: 'ws-1',
        workspace: { ownerId: 'owner-1' },
      });

      await expect(
        service.remove('file-1', 'user-1', UserRole.CLIENT),
      ).rejects.toThrow(NotFoundException);
      expect(mockPrismaService.file.update).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when caller is neither uploader nor workspace owner', async () => {
      mockPrismaService.file.findUnique.mockResolvedValue({
        id: 'file-1',
        uploadedById: 'someone-else',
        deletedAt: null,
        workspaceId: 'ws-1',
        workspace: { ownerId: 'owner-1' },
      });

      await expect(
        service.remove('file-1', 'user-1', UserRole.CLIENT),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrismaService.file.update).not.toHaveBeenCalled();
    });

    it('soft-deletes the file when caller is the uploader', async () => {
      const deletedAt = new Date('2026-01-01T00:00:00Z');
      mockPrismaService.file.findUnique.mockResolvedValue({
        id: 'file-1',
        uploadedById: 'user-1',
        deletedAt: null,
        workspaceId: 'ws-1',
        workspace: { ownerId: 'owner-1' },
      });
      mockPrismaService.file.update.mockResolvedValue({
        id: 'file-1',
        deletedAt,
      });

      const result = await service.remove('file-1', 'user-1', UserRole.CLIENT);

      expect(mockPrismaService.file.update).toHaveBeenCalledWith({
        where: { id: 'file-1' },
        data: { deletedAt: expect.any(Date) },
        select: { id: true, deletedAt: true },
      });
      expect(result).toEqual({ id: 'file-1', deletedAt });
    });

    it('soft-deletes the file when caller is the workspace owner', async () => {
      mockPrismaService.file.findUnique.mockResolvedValue({
        id: 'file-1',
        uploadedById: 'someone-else',
        deletedAt: null,
        workspaceId: 'ws-1',
        workspace: { ownerId: 'owner-1' },
      });
      mockPrismaService.file.update.mockResolvedValue({
        id: 'file-1',
        deletedAt: new Date(),
      });

      await service.remove('file-1', 'owner-1', UserRole.FREELANCER);

      expect(mockPrismaService.file.update).toHaveBeenCalled();
    });
  });

  // ─── listTrash ──────────────────────────────────────────────────────────────

  describe('listTrash', () => {
    it('returns trashed files when caller is a workspace member', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue(
        workspaceWithMember('user-1'),
      );
      const trashed = [
        {
          id: 'f1',
          name: 'old.pdf',
          deletedAt: new Date('2026-05-10T00:00:00Z'),
        },
      ];
      mockPrismaService.file.findMany.mockResolvedValue(trashed);

      const result = await service.listTrash('ws-1', 'user-1', UserRole.CLIENT);

      expect(result).toEqual(trashed);
      expect(mockPrismaService.file.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            workspaceId: 'ws-1',
            deletedAt: expect.objectContaining({ not: null }),
          }),
          orderBy: { deletedAt: 'desc' },
        }),
      );
    });

    it('returns trashed files when caller is the workspace owner', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue(
        workspaceOwnedBy('owner-1'),
      );
      mockPrismaService.file.findMany.mockResolvedValue([]);

      await expect(
        service.listTrash('ws-1', 'owner-1', UserRole.FREELANCER),
      ).resolves.toEqual([]);
    });

    it('throws ForbiddenException when caller is not a workspace member', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue({
        ownerId: 'someone-else',
        members: [],
      });

      await expect(
        service.listTrash('ws-1', 'user-1', UserRole.CLIENT),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrismaService.file.findMany).not.toHaveBeenCalled();
    });

    it('filters by the 30-day retention cutoff (gte: now - 30 days)', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue(
        workspaceWithMember('user-1'),
      );
      mockPrismaService.file.findMany.mockResolvedValue([]);

      const before = Date.now();
      await service.listTrash('ws-1', 'user-1', UserRole.CLIENT);
      const after = Date.now();

      const call = mockPrismaService.file.findMany.mock.calls[0][0] as {
        where: { deletedAt: { gte: Date } };
      };
      const cutoffMs = call.where.deletedAt.gte.getTime();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      // Cutoff should be ~30 days before "now", with a generous tolerance
      // to account for the time spent inside the call.
      expect(cutoffMs).toBeGreaterThanOrEqual(before - thirtyDaysMs - 50);
      expect(cutoffMs).toBeLessThanOrEqual(after - thirtyDaysMs + 50);
    });
  });

  // ─── restore ────────────────────────────────────────────────────────────────

  describe('restore', () => {
    const recentDeletedAt = () => new Date(Date.now() - 24 * 60 * 60 * 1000);

    const setupHappyPath = () => {
      mockPrismaService.file.findUnique.mockResolvedValue({
        id: 'file-1',
        size: 500,
        uploadedById: 'user-1',
        deletedAt: recentDeletedAt(),
        workspaceId: 'ws-1',
        workspace: { ownerId: 'owner-1' },
      });
      mockPrismaService.user.findUniqueOrThrow.mockResolvedValue({
        plan: UserPlan.FREE,
      });
      mockPrismaService.file.aggregate.mockResolvedValue({ _sum: { size: 0 } });
      mockPrismaService.file.update.mockResolvedValue({
        id: 'file-1',
        name: 'old.pdf',
      });
      mockPrismaService.$executeRaw.mockResolvedValue(1);
      mockPrismaService.$transaction.mockImplementation(defaultTransactionImpl);
    };

    it('throws NotFoundException when the file does not exist', async () => {
      mockPrismaService.file.findUnique.mockResolvedValue(null);

      await expect(
        service.restore('missing', 'user-1', UserRole.CLIENT),
      ).rejects.toThrow(NotFoundException);
      expect(mockPrismaService.file.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the file is not deleted (deletedAt is null)', async () => {
      mockPrismaService.file.findUnique.mockResolvedValue({
        id: 'file-1',
        size: 500,
        uploadedById: 'user-1',
        deletedAt: null,
        workspaceId: 'ws-1',
        workspace: { ownerId: 'owner-1' },
      });

      await expect(
        service.restore('file-1', 'user-1', UserRole.CLIENT),
      ).rejects.toThrow(NotFoundException);
      expect(mockPrismaService.file.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the file is past the 30-day window', async () => {
      const expired = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      mockPrismaService.file.findUnique.mockResolvedValue({
        id: 'file-1',
        size: 500,
        uploadedById: 'user-1',
        deletedAt: expired,
        workspaceId: 'ws-1',
        workspace: { ownerId: 'owner-1' },
      });

      await expect(
        service.restore('file-1', 'user-1', UserRole.CLIENT),
      ).rejects.toThrow(NotFoundException);
      expect(mockPrismaService.file.update).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when caller is neither uploader nor workspace owner', async () => {
      mockPrismaService.file.findUnique.mockResolvedValue({
        id: 'file-1',
        size: 500,
        uploadedById: 'someone-else',
        deletedAt: recentDeletedAt(),
        workspaceId: 'ws-1',
        workspace: { ownerId: 'owner-1' },
      });

      await expect(
        service.restore('file-1', 'user-1', UserRole.CLIENT),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrismaService.file.update).not.toHaveBeenCalled();
    });

    it('throws PayloadTooLargeException when restoring would exceed the workspace storage limit', async () => {
      setupHappyPath();
      // The file being restored is soft-deleted within retention, so it is
      // already in the sum returned by aggregate. A workspace whose total
      // (active + retained trash) exceeds the plan limit — e.g. after a plan
      // downgrade — should refuse the restore.
      mockPrismaService.file.aggregate.mockResolvedValue({
        _sum: { size: STORAGE_LIMITS.FREE + 1 },
      });
      mockPrismaService.file.findUnique.mockResolvedValue({
        id: 'file-1',
        size: 500,
        uploadedById: 'user-1',
        deletedAt: recentDeletedAt(),
        workspaceId: 'ws-1',
        workspace: { ownerId: 'owner-1' },
      });

      await expect(
        service.restore('file-1', 'user-1', UserRole.CLIENT),
      ).rejects.toThrow(PayloadTooLargeException);
      expect(mockPrismaService.file.update).not.toHaveBeenCalled();
    });

    it('counts soft-deleted bytes within retention towards the restore quota check', async () => {
      setupHappyPath();

      await service.restore('file-1', 'user-1', UserRole.CLIENT);

      const aggregateCall = mockPrismaService.file.aggregate.mock.calls[0][0];
      expect(aggregateCall.where).toEqual(
        expect.objectContaining({
          workspaceId: 'ws-1',
          OR: expect.arrayContaining([
            { deletedAt: null },
            expect.objectContaining({
              deletedAt: expect.objectContaining({ gte: expect.any(Date) }),
            }),
          ]),
        }),
      );
    });

    it('restores the file when caller is the uploader', async () => {
      setupHappyPath();

      await service.restore('file-1', 'user-1', UserRole.CLIENT);

      expect(mockPrismaService.file.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'file-1' },
          data: { deletedAt: null },
        }),
      );
    });

    it('restores the file when caller is the workspace owner', async () => {
      setupHappyPath();
      mockPrismaService.file.findUnique.mockResolvedValue({
        id: 'file-1',
        size: 500,
        uploadedById: 'someone-else',
        deletedAt: recentDeletedAt(),
        workspaceId: 'ws-1',
        workspace: { ownerId: 'owner-1' },
      });

      await service.restore('file-1', 'owner-1', UserRole.FREELANCER);

      expect(mockPrismaService.file.update).toHaveBeenCalled();
    });

    it('takes a per-workspace advisory lock inside the transaction', async () => {
      setupHappyPath();

      await service.restore('file-1', 'user-1', UserRole.CLIENT);

      expect(mockPrismaService.$executeRaw).toHaveBeenCalledTimes(1);
      const [strings, ...values] =
        mockPrismaService.$executeRaw.mock.calls[0];
      expect((strings as string[]).join('?')).toContain(
        'pg_advisory_xact_lock',
      );
      expect(values).toContain('ws-1');
    });
  });
});
