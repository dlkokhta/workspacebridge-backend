import { Test, TestingModule } from '@nestjs/testing';
import { LoginAlertService } from './login-alert.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';

const mockPrismaService = {
  auditLog: {
    findFirst: jest.fn(),
    create: jest.fn().mockResolvedValue({}),
  },
};
const mockMailService = {
  sendNewDeviceAlertEmail: jest.fn().mockResolvedValue(undefined),
};

const params = {
  userId: 'user-1',
  email: 'a@b.com',
  ip: '1.2.3.4',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120',
};

// expect.objectContaining returns `any`; typed wrapper keeps the spec clean
// under @typescript-eslint/no-unsafe-assignment.
const containing = (obj: Record<string, unknown>): Record<string, unknown> =>
  expect.objectContaining(obj) as Record<string, unknown>;

describe('LoginAlertService', () => {
  let service: LoginAlertService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoginAlertService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: MailService, useValue: mockMailService },
      ],
    }).compile();

    service = module.get<LoginAlertService>(LoginAlertService);
    jest.clearAllMocks();
  });

  describe('notifyIfNewDevice', () => {
    it('alerts on a new device when prior logins exist from other devices', async () => {
      mockPrismaService.auditLog.findFirst
        .mockResolvedValueOnce(null) // no prior login with this user-agent
        .mockResolvedValueOnce({ id: 'prior' }); // but some prior login exists

      await service.notifyIfNewDevice(params);

      expect(mockMailService.sendNewDeviceAlertEmail).toHaveBeenCalledWith(
        'a@b.com',
        expect.objectContaining({
          device: 'Chrome · Windows',
          ip: '1.2.3.4',
        }),
      );
      expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith({
        data: containing({ action: 'auth.new_device_login' }),
      });
    });

    it('does not alert when the device has been seen before', async () => {
      mockPrismaService.auditLog.findFirst.mockResolvedValueOnce({
        id: 'known',
      });

      await service.notifyIfNewDevice(params);

      expect(mockMailService.sendNewDeviceAlertEmail).not.toHaveBeenCalled();
    });

    it('does not alert on the very first login', async () => {
      mockPrismaService.auditLog.findFirst
        .mockResolvedValueOnce(null) // no login with this user-agent
        .mockResolvedValueOnce(null); // and no prior login at all

      await service.notifyIfNewDevice(params);

      expect(mockMailService.sendNewDeviceAlertEmail).not.toHaveBeenCalled();
    });

    it('skips silently when the user-agent is unknown', async () => {
      await service.notifyIfNewDevice({ ...params, userAgent: undefined });

      expect(mockPrismaService.auditLog.findFirst).not.toHaveBeenCalled();
      expect(mockMailService.sendNewDeviceAlertEmail).not.toHaveBeenCalled();
    });

    it('never throws when the device lookup fails', async () => {
      mockPrismaService.auditLog.findFirst.mockRejectedValueOnce(
        new Error('db down'),
      );

      await expect(service.notifyIfNewDevice(params)).resolves.toBeUndefined();
      expect(mockMailService.sendNewDeviceAlertEmail).not.toHaveBeenCalled();
    });
  });

  describe('handleSuccessfulLogin', () => {
    it('runs the new-device check before recording the success audit', async () => {
      // Known device → no alert, but the success row is still written.
      mockPrismaService.auditLog.findFirst.mockResolvedValueOnce({
        id: 'known',
      });

      await service.handleSuccessfulLogin('auth.login', params);

      expect(mockMailService.sendNewDeviceAlertEmail).not.toHaveBeenCalled();
      // email/ip/userAgent now live in dedicated columns, not metadata.
      expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith({
        data: containing({
          action: 'auth.login',
          actorId: 'user-1',
          email: 'a@b.com',
          ip: '1.2.3.4',
          userAgent: params.userAgent,
        }),
      });
      // the check ran before the write was issued
      expect(
        mockPrismaService.auditLog.findFirst.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mockPrismaService.auditLog.create.mock.invocationCallOrder[0],
      );
    });

    it('writes provided context as columns and omits undefined ip/userAgent', async () => {
      await service.handleSuccessfulLogin('auth.login', {
        userId: 'user-1',
        email: 'a@b.com',
      });

      const calls = mockPrismaService.auditLog.create.mock.calls as [
        [
          {
            data: {
              email?: string;
              ip?: string;
              userAgent?: string;
              metadata?: unknown;
            };
          },
        ],
      ];
      const { data } = calls[0][0];
      expect(data.email).toBe('a@b.com');
      expect(data.ip).toBeUndefined();
      expect(data.userAgent).toBeUndefined();
      expect(data.metadata).toBeUndefined();
    });
  });
});
