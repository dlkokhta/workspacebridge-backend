import { Test, TestingModule } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

const mockHealthService = {
  checkDatabase: jest.fn(),
};

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: HealthService, useValue: mockHealthService }],
    }).compile();
    controller = module.get<HealthController>(HealthController);
  });

  it('liveness reports ok with uptime and a timestamp', () => {
    const result = controller.liveness();
    expect(result.status).toBe('ok');
    expect(typeof result.uptime).toBe('number');
    expect(typeof result.timestamp).toBe('string');
  });

  it('readiness reports ok when the DB is up', async () => {
    mockHealthService.checkDatabase.mockResolvedValue(true);

    const result = await controller.readiness();

    expect(result).toEqual(
      expect.objectContaining({ status: 'ok', database: 'up' }),
    );
  });

  it('readiness throws 503 when the DB is down', async () => {
    mockHealthService.checkDatabase.mockResolvedValue(false);

    await expect(controller.readiness()).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
