import { Test, TestingModule } from '@nestjs/testing';
import { HealthService } from './health.service';
import { PrismaService } from '../prisma/prisma.service';

const mockPrismaService = {
  user: { findFirst: jest.fn() },
};

describe('HealthService', () => {
  let service: HealthService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();
    service = module.get<HealthService>(HealthService);
  });

  it('returns true when the database responds', async () => {
    mockPrismaService.user.findFirst.mockResolvedValue({ id: 'x' });
    await expect(service.checkDatabase()).resolves.toBe(true);
  });

  it('returns true even when the table is empty (null result)', async () => {
    mockPrismaService.user.findFirst.mockResolvedValue(null);
    await expect(service.checkDatabase()).resolves.toBe(true);
  });

  it('returns false when the database query throws', async () => {
    mockPrismaService.user.findFirst.mockRejectedValue(new Error('db down'));
    await expect(service.checkDatabase()).resolves.toBe(false);
  });
});
