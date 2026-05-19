import { Test, TestingModule } from '@nestjs/testing';
import { FileCleanupService } from './file-cleanup.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from './storage/storage.service';

const mockPrismaService = {
  file: {
    findMany: jest.fn(),
    delete: jest.fn(),
  },
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
};

const mockStorageService: jest.Mocked<StorageService> = {
  upload: jest.fn(),
  getDownloadUrl: jest.fn(),
  delete: jest.fn(),
};

describe('FileCleanupService', () => {
  let service: FileCleanupService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FileCleanupService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: StorageService, useValue: mockStorageService },
      ],
    }).compile();

    service = module.get<FileCleanupService>(FileCleanupService);

    jest.clearAllMocks();
    mockPrismaService.$executeRaw.mockResolvedValue(1);
  });

  describe('sweepExpiredTrash', () => {
    it('skips the sweep when another instance holds the advisory lock', async () => {
      mockPrismaService.$queryRaw.mockResolvedValue([{ locked: false }]);

      await service.sweepExpiredTrash();

      expect(mockPrismaService.file.findMany).not.toHaveBeenCalled();
      expect(mockStorageService.delete).not.toHaveBeenCalled();
      // No unlock call when we never acquired the lock.
      expect(mockPrismaService.$executeRaw).not.toHaveBeenCalled();
    });

    it('acquires the lock, runs the sweep, and releases the lock', async () => {
      mockPrismaService.$queryRaw.mockResolvedValue([{ locked: true }]);
      mockPrismaService.file.findMany.mockResolvedValue([]);

      await service.sweepExpiredTrash();

      expect(mockPrismaService.file.findMany).toHaveBeenCalled();
      // Releases the lock via pg_advisory_unlock.
      const calls = mockPrismaService.$executeRaw.mock.calls;
      const releasedKey = (calls[0][0] as string[]).join('?');
      expect(releasedKey).toContain('pg_advisory_unlock');
    });

    it('releases the lock even when processing throws', async () => {
      mockPrismaService.$queryRaw.mockResolvedValue([{ locked: true }]);
      mockPrismaService.file.findMany.mockRejectedValue(new Error('db down'));

      await expect(service.sweepExpiredTrash()).rejects.toThrow('db down');

      const calls = mockPrismaService.$executeRaw.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const releasedKey = (calls[0][0] as string[]).join('?');
      expect(releasedKey).toContain('pg_advisory_unlock');
    });

    it('deletes the R2 object and the DB row for each expired file', async () => {
      mockPrismaService.$queryRaw.mockResolvedValue([{ locked: true }]);
      // First call returns the batch (< BATCH_SIZE so the loop exits after).
      mockPrismaService.file.findMany
        .mockResolvedValueOnce([
          { id: 'f1', storageKey: 'workspaces/ws-1/files/f1.pdf' },
          { id: 'f2', storageKey: 'workspaces/ws-1/files/f2.pdf' },
        ])
        .mockResolvedValue([]);
      mockStorageService.delete.mockResolvedValue(undefined);
      mockPrismaService.file.delete.mockResolvedValue({ id: 'f1' });

      await service.sweepExpiredTrash();

      expect(mockStorageService.delete).toHaveBeenCalledTimes(2);
      expect(mockStorageService.delete).toHaveBeenCalledWith(
        'workspaces/ws-1/files/f1.pdf',
      );
      expect(mockStorageService.delete).toHaveBeenCalledWith(
        'workspaces/ws-1/files/f2.pdf',
      );
      expect(mockPrismaService.file.delete).toHaveBeenCalledTimes(2);
    });

    it('continues to the next file when one purge fails', async () => {
      mockPrismaService.$queryRaw.mockResolvedValue([{ locked: true }]);
      mockPrismaService.file.findMany
        .mockResolvedValueOnce([
          { id: 'f1', storageKey: 'workspaces/ws-1/files/f1.pdf' },
          { id: 'f2', storageKey: 'workspaces/ws-1/files/f2.pdf' },
        ])
        .mockResolvedValue([]);
      // First R2 delete fails; the second should still run.
      mockStorageService.delete
        .mockRejectedValueOnce(new Error('R2 unreachable'))
        .mockResolvedValueOnce(undefined);
      mockPrismaService.file.delete.mockResolvedValue({ id: 'f2' });

      await service.sweepExpiredTrash();

      expect(mockStorageService.delete).toHaveBeenCalledTimes(2);
      // The DB row for the failing file should NOT be deleted.
      expect(mockPrismaService.file.delete).toHaveBeenCalledTimes(1);
      expect(mockPrismaService.file.delete).toHaveBeenCalledWith({
        where: { id: 'f2' },
      });
    });
  });
});
