import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PasswordHistoryService } from './password-history.service';
import { PrismaService } from '../../../prisma/prisma.service';
import * as argon2 from 'argon2';

jest.mock('argon2');
const mockedVerify = argon2.verify as jest.MockedFunction<typeof argon2.verify>;

const mockPrisma = {
  passwordHistory: {
    findMany: jest.fn(),
    create: jest.fn(),
    deleteMany: jest.fn(),
  },
};

describe('PasswordHistoryService', () => {
  let service: PasswordHistoryService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasswordHistoryService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get(PasswordHistoryService);
    jest.clearAllMocks();
  });

  describe('assertNotReused', () => {
    it('rejects a password matching the current one', async () => {
      mockedVerify.mockResolvedValue(true);

      await expect(
        service.assertNotReused('u1', 'newPass', 'current-hash'),
      ).rejects.toThrow(BadRequestException);
      // short-circuits before touching history
      expect(mockPrisma.passwordHistory.findMany).not.toHaveBeenCalled();
    });

    it('rejects a password matching a remembered previous one', async () => {
      // not equal to current, but equal to a history entry
      mockedVerify
        .mockResolvedValueOnce(false) // vs current
        .mockResolvedValueOnce(false) // vs history[0]
        .mockResolvedValueOnce(true); // vs history[1]
      mockPrisma.passwordHistory.findMany.mockResolvedValue([
        { password: 'old-1' },
        { password: 'old-2' },
      ]);

      await expect(
        service.assertNotReused('u1', 'newPass', 'current-hash'),
      ).rejects.toThrow(BadRequestException);
    });

    it('passes when the password matches nothing', async () => {
      mockedVerify.mockResolvedValue(false);
      mockPrisma.passwordHistory.findMany.mockResolvedValue([
        { password: 'old-1' },
      ]);

      await expect(
        service.assertNotReused('u1', 'newPass', 'current-hash'),
      ).resolves.toBeUndefined();
    });

    it('skips the current-password check when there is no current hash', async () => {
      mockPrisma.passwordHistory.findMany.mockResolvedValue([]);

      await service.assertNotReused('u1', 'newPass', null);

      expect(mockedVerify).not.toHaveBeenCalled();
    });
  });

  describe('record', () => {
    it('does nothing when there is no previous hash', async () => {
      await service.record('u1', null);
      expect(mockPrisma.passwordHistory.create).not.toHaveBeenCalled();
    });

    it('stores the old hash and prunes beyond the limit', async () => {
      mockPrisma.passwordHistory.create.mockResolvedValue({});
      // 6 entries → newest 5 kept, oldest 1 pruned
      mockPrisma.passwordHistory.findMany.mockResolvedValue([
        { id: 'a' },
        { id: 'b' },
        { id: 'c' },
        { id: 'd' },
        { id: 'e' },
        { id: 'f' },
      ]);

      await service.record('u1', 'old-hash');

      expect(mockPrisma.passwordHistory.create).toHaveBeenCalledWith({
        data: { userId: 'u1', password: 'old-hash' },
      });
      expect(mockPrisma.passwordHistory.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['f'] } },
      });
    });

    it('does not prune when within the limit', async () => {
      mockPrisma.passwordHistory.create.mockResolvedValue({});
      mockPrisma.passwordHistory.findMany.mockResolvedValue([
        { id: 'a' },
        { id: 'b' },
      ]);

      await service.record('u1', 'old-hash');

      expect(mockPrisma.passwordHistory.deleteMany).not.toHaveBeenCalled();
    });
  });
});
