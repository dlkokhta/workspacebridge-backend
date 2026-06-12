import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import * as speakeasy from 'speakeasy';
import { TwoFactorAuthService } from './two-factor-auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { LoginAlertService } from './login-alert.service';

jest.mock('argon2');
jest.mock('speakeasy');
jest.mock('../libs/common/utils/secret-crypto', () => ({
  encryptSecret: jest.fn((s: string) => `enc:${s}`),
  decryptSecret: jest.fn((s: string) => s.replace(/^enc:/, '')),
}));

const mockedTotpVerify = speakeasy.totp.verify as jest.MockedFunction<
  typeof speakeasy.totp.verify
>;

const fakeUser = {
  id: 'user-123',
  email: 'john@example.com',
  password: 'hashed-password',
  role: 'FREELANCER',
  status: 'ACTIVE',
  isTwoFactorEnabled: true,
  twoFactorSecret: 'enc:base32secret',
};

const mockPrismaService = {
  user: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  pendingTwoFactorSetup: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
  },
  twoFactorAttempt: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  backupCode: {
    findFirst: jest.fn(),
    createMany: jest.fn(),
    update: jest.fn(),
    deleteMany: jest.fn(),
  },
  session: {
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    deleteMany: jest.fn(),
  },
  auditLog: {
    create: jest.fn().mockResolvedValue({}),
  },
  $transaction: jest.fn(),
};

const mockJwtService = {
  sign: jest.fn().mockReturnValue('signed-token'),
  verify: jest.fn(),
};

const mockConfigService = {
  getOrThrow: jest.fn().mockReturnValue('test-secret'),
  get: jest.fn().mockReturnValue(undefined),
};

const mockLoginAlertService = {
  handleSuccessfulLogin: jest.fn(),
};

// matches the service's hashing: sha256 over the code with the dash removed
const sha256 = (code: string) =>
  createHash('sha256').update(code.replace('-', '')).digest('hex');

describe('TwoFactorAuthService — backup codes', () => {
  let service: TwoFactorAuthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TwoFactorAuthService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: LoginAlertService, useValue: mockLoginAlertService },
      ],
    }).compile();

    service = module.get<TwoFactorAuthService>(TwoFactorAuthService);
    jest.clearAllMocks();
    mockPrismaService.session.findMany.mockResolvedValue([]);
    mockPrismaService.auditLog.create.mockResolvedValue({});
  });

  // ─── enableTwoFactor ────────────────────────────────────────────────────────

  describe('enableTwoFactor', () => {
    it('returns 10 one-time backup codes and stores only their hashes', async () => {
      mockPrismaService.pendingTwoFactorSetup.findUnique.mockResolvedValue({
        userId: 'user-123',
        secret: 'enc:base32secret',
        expiresAt: new Date(Date.now() + 10000),
      });
      mockedTotpVerify.mockReturnValue(true);
      mockPrismaService.$transaction.mockResolvedValue([{}, {}]);

      const result = await service.enableTwoFactor('user-123', '123456');

      expect(result.message).toContain('2FA enabled');
      expect(result.backupCodes).toHaveLength(10);
      // xxxx-xxxx hex format, shown to the user exactly once
      for (const code of result.backupCodes) {
        expect(code).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}$/);
      }
      // at rest: previous set wiped, only sha256 hashes stored
      expect(mockPrismaService.backupCode.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-123' },
      });
      const createCalls = mockPrismaService.backupCode.createMany.mock
        .calls as [[{ data: { userId: string; code: string }[] }]];
      const created = createCalls[0][0];
      expect(created.data).toHaveLength(10);
      expect(created.data[0].code).toBe(sha256(result.backupCodes[0]));
      expect(created.data[0].code).not.toContain('-');
    });
  });

  // ─── regenerateBackupCodes ──────────────────────────────────────────────────

  describe('regenerateBackupCodes', () => {
    it('rejects when 2FA is not enabled', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        ...fakeUser,
        isTwoFactorEnabled: false,
        twoFactorSecret: null,
      });

      await expect(
        service.regenerateBackupCodes('user-123', '123456'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an invalid TOTP code without touching stored codes', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(fakeUser);
      mockedTotpVerify.mockReturnValue(false);

      await expect(
        service.regenerateBackupCodes('user-123', '000000'),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockPrismaService.backupCode.deleteMany).not.toHaveBeenCalled();
      expect(mockPrismaService.backupCode.createMany).not.toHaveBeenCalled();
    });

    it('replaces the whole set and audits on a valid TOTP code', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(fakeUser);
      mockedTotpVerify.mockReturnValue(true);

      const result = await service.regenerateBackupCodes('user-123', '123456');

      expect(result.backupCodes).toHaveLength(10);
      expect(mockPrismaService.backupCode.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-123' },
      });
      expect(mockPrismaService.backupCode.createMany).toHaveBeenCalled();
      expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'auth.backup_codes_regenerated',
        }) as Record<string, unknown>,
      });
    });
  });

  // ─── verifyTwoFactorForLogin with a backup code ─────────────────────────────

  describe('verifyTwoFactorForLogin (backup code path)', () => {
    const validAttempt = {
      jti: 'jti-1',
      userId: 'user-123',
      attempts: 0,
      consumed: false,
      expiresAt: new Date(Date.now() + 10000),
    };

    const arrangeHappyPath = () => {
      mockJwtService.verify.mockReturnValue({
        userId: 'user-123',
        email: 'john@example.com',
        role: 'FREELANCER',
        rememberMe: false,
        isTwoFactorAuthenticated: false,
        jti: 'jti-1',
      });
      mockPrismaService.twoFactorAttempt.findUnique.mockResolvedValue(
        validAttempt,
      );
      mockPrismaService.user.findUnique.mockResolvedValue(fakeUser);
    };

    it('rejects when neither code nor backupCode is provided', async () => {
      await expect(
        service.verifyTwoFactorForLogin('temp', undefined),
      ).rejects.toThrow(BadRequestException);
    });

    it('logs in with a valid unused backup code and marks it used', async () => {
      arrangeHappyPath();
      mockPrismaService.backupCode.findFirst.mockResolvedValue({
        id: 'bc-1',
        userId: 'user-123',
        usedAt: null,
      });
      mockPrismaService.twoFactorAttempt.update.mockResolvedValue({});
      mockPrismaService.session.create.mockResolvedValue({});

      const result = await service.verifyTwoFactorForLogin(
        'temp',
        undefined,
        '1.2.3.4',
        'Chrome',
        'a1b2-c3d4',
      );

      expect(result).toHaveProperty('accessToken');
      // lookup goes through the sha256 hash, never the plaintext
      expect(mockPrismaService.backupCode.findFirst).toHaveBeenCalledWith({
        where: {
          userId: 'user-123',
          code: sha256('a1b2-c3d4'),
          usedAt: null,
        },
      });
      // one-time use
      expect(mockPrismaService.backupCode.update).toHaveBeenCalledWith({
        where: { id: 'bc-1' },
        data: { usedAt: expect.any(Date) as Date },
      });
      // TOTP was never consulted
      expect(mockedTotpVerify).not.toHaveBeenCalled();
      expect(mockLoginAlertService.handleSuccessfulLogin).toHaveBeenCalledWith(
        'auth.2fa_login',
        expect.objectContaining({ userId: 'user-123' }),
      );
    });

    it('rejects an unknown or already used backup code and counts the attempt', async () => {
      arrangeHappyPath();
      mockPrismaService.backupCode.findFirst.mockResolvedValue(null);
      mockPrismaService.twoFactorAttempt.update.mockResolvedValue({});

      await expect(
        service.verifyTwoFactorForLogin(
          'temp',
          undefined,
          '1.2.3.4',
          'Chrome',
          'dead-beef',
        ),
      ).rejects.toThrow('Invalid or already used backup code');

      // failed guess counts toward the per-token cap
      expect(mockPrismaService.twoFactorAttempt.update).toHaveBeenCalledWith({
        where: { jti: 'jti-1' },
        data: { attempts: 1, consumed: false },
      });
      expect(mockPrismaService.backupCode.update).not.toHaveBeenCalled();
    });

    it('burns the tempToken on the 5th failed backup-code guess', async () => {
      arrangeHappyPath();
      mockPrismaService.twoFactorAttempt.findUnique.mockResolvedValue({
        ...validAttempt,
        attempts: 4,
      });
      mockPrismaService.backupCode.findFirst.mockResolvedValue(null);
      mockPrismaService.twoFactorAttempt.update.mockResolvedValue({});

      await expect(
        service.verifyTwoFactorForLogin(
          'temp',
          undefined,
          undefined,
          undefined,
          'dead-beef',
        ),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockPrismaService.twoFactorAttempt.update).toHaveBeenCalledWith({
        where: { jti: 'jti-1' },
        data: { attempts: 5, consumed: true },
      });
    });
  });
});
