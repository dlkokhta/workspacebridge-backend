import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UserService } from './user.service';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordBreachService } from '../libs/common/services/password-breach.service';
import { PasswordHistoryService } from '../libs/common/services/password-history.service';
import { MailService } from '../mail/mail.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import * as argon2 from 'argon2';

jest.mock('argon2');

const mockedHash = argon2.hash as jest.MockedFunction<typeof argon2.hash>;
const mockedVerify = argon2.verify as jest.MockedFunction<typeof argon2.verify>;

const fakeUser = {
  id: 'user-123',
  firstname: 'John',
  lastname: 'Doe',
  email: 'john@example.com',
  password: 'hashed-password',
  role: 'USER',
  picture: null,
  method: 'LOCAL',
  isVerified: true,
  createdAt: new Date(),
};

const mockPrismaService = {
  user: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  session: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  },
  account: {
    findMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  auditLog: {
    create: jest.fn().mockResolvedValue({}),
  },
};

const mockMailService = {
  sendSignInMethodAddedEmail: jest.fn().mockResolvedValue(undefined),
};

const mockJwtService = {
  verify: jest.fn(),
};

const mockConfigService = {
  get: jest.fn().mockReturnValue(undefined),
  getOrThrow: jest.fn().mockReturnValue('test-jwt-secret'),
};

const mockPasswordBreachService = {
  isBreached: jest.fn().mockResolvedValue(false),
};

const mockPasswordHistoryService = {
  assertNotReused: jest.fn(),
  record: jest.fn(),
};

describe('UserService', () => {
  let service: UserService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: PasswordBreachService, useValue: mockPasswordBreachService },
        {
          provide: PasswordHistoryService,
          useValue: mockPasswordHistoryService,
        },
        { provide: MailService, useValue: mockMailService },
      ],
    }).compile();

    service = module.get<UserService>(UserService);

    jest.clearAllMocks();
  });

  // ─── findByEmail ────────────────────────────────────────────────────────────

  describe('findByEmail', () => {
    it('returns a user when found', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(fakeUser);

      const result = await service.findByEmail('john@example.com');

      expect(mockPrismaService.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'john@example.com' },
      });
      expect(result).toEqual(fakeUser);
    });

    it('returns null when user does not exist', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      const result = await service.findByEmail('nobody@example.com');

      expect(result).toBeNull();
    });
  });

  // ─── findById ───────────────────────────────────────────────────────────────

  describe('findById', () => {
    it('returns a user when found', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(fakeUser);

      const result = await service.findById('user-123');

      expect(mockPrismaService.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-123' },
      });
      expect(result).toEqual(fakeUser);
    });

    it('returns null when user does not exist', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      const result = await service.findById('non-existent-id');

      expect(result).toBeNull();
    });
  });

  // ─── create ─────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('hashes the password and creates the user', async () => {
      mockedHash.mockResolvedValue('hashed-pw' as never);
      mockPrismaService.user.create.mockResolvedValue(fakeUser);

      const dto = {
        firstname: 'John',
        lastname: 'Doe',
        email: 'john@example.com',
        password: 'plaintext',
        passwordRepeat: 'plaintext',
      };

      const result = await service.create(dto);

      expect(mockedHash).toHaveBeenCalledWith('plaintext');
      expect(mockPrismaService.user.create).toHaveBeenCalledWith({
        data: {
          firstname: 'John',
          lastname: 'Doe',
          email: 'john@example.com',
          password: 'hashed-pw',
        },
      });
      expect(result).toEqual(fakeUser);
    });

    it('sets password to null when no password is provided (Google user)', async () => {
      mockPrismaService.user.create.mockResolvedValue({
        ...fakeUser,
        password: null,
        method: 'GOOGLE',
      });

      const dto = {
        firstname: 'Jane',
        lastname: 'Doe',
        email: 'jane@example.com',
        password: undefined,
        passwordRepeat: undefined,
      };

      await service.create(dto as any);

      expect(mockedHash).not.toHaveBeenCalled();

      expect(mockPrismaService.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ password: null }),
      });
    });
  });

  // ─── getProfile ─────────────────────────────────────────────────────────────

  describe('getProfile', () => {
    it('returns the user profile without password', async () => {
      const profileResult = {
        id: fakeUser.id,
        firstname: fakeUser.firstname,
        lastname: fakeUser.lastname,
        email: fakeUser.email,
        role: fakeUser.role,
        picture: fakeUser.picture,
        method: fakeUser.method,
        createdAt: fakeUser.createdAt,
      };
      mockPrismaService.user.findUnique.mockResolvedValue(profileResult);

      const result = await service.getProfile('user-123');

      expect(result).toEqual(profileResult);
      expect(result).not.toHaveProperty('password');
    });

    it('throws NotFoundException when user does not exist', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      await expect(service.getProfile('non-existent-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── updateProfile ──────────────────────────────────────────────────────────

  describe('updateProfile', () => {
    it('updates and returns the profile', async () => {
      const updatedProfile = { ...fakeUser, firstname: 'Jane' };
      mockPrismaService.user.update.mockResolvedValue(updatedProfile);

      const dto = { firstName: 'Jane', lastName: 'Doe' };
      const result = await service.updateProfile('user-123', dto);

      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { id: 'user-123' },
        data: { firstname: 'Jane', lastname: 'Doe' },
        select: expect.any(Object),
      });
      expect(result).toEqual(updatedProfile);
    });
  });

  // ─── changePassword ─────────────────────────────────────────────────────────

  describe('changePassword', () => {
    it('throws BadRequestException when user has no password (Google account)', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        ...fakeUser,
        password: null,
      });

      const dto = { currentPassword: 'old', newPassword: 'newPass123' };

      await expect(service.changePassword('user-123', dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when user is not found', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      const dto = { currentPassword: 'old', newPassword: 'newPass123' };

      await expect(service.changePassword('user-123', dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when current password is wrong', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(fakeUser);
      mockedVerify.mockResolvedValue(false);

      const dto = { currentPassword: 'wrong-password', newPassword: 'newPass123' };

      await expect(service.changePassword('user-123', dto)).rejects.toThrow(
        new BadRequestException('Current password is incorrect'),
      );
      // No HIBP traffic for unauthenticated guesses — the breach check only
      // runs once the current password has been verified.
      expect(mockPasswordBreachService.isBreached).not.toHaveBeenCalled();
    });

    it('rejects a breached new password without saving it', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(fakeUser);
      mockedVerify.mockResolvedValue(true);
      mockPasswordBreachService.isBreached.mockResolvedValueOnce(true);

      const dto = { currentPassword: 'correct-password', newPassword: 'breached-pass' };

      await expect(service.changePassword('user-123', dto)).rejects.toThrow(
        new BadRequestException(
          'This password has appeared in a known data breach. Please choose a different one.',
        ),
      );

      expect(mockPasswordBreachService.isBreached).toHaveBeenCalledWith(
        'breached-pass',
      );
      expect(mockedHash).not.toHaveBeenCalled();
      expect(mockPrismaService.user.update).not.toHaveBeenCalled();
    });

    it('rejects a reused password without saving it', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(fakeUser);
      mockedVerify.mockResolvedValue(true);
      mockPasswordHistoryService.assertNotReused.mockRejectedValueOnce(
        new BadRequestException(
          "You can't reuse a recent password. Please choose a different one.",
        ),
      );

      const dto = { currentPassword: 'correct-password', newPassword: 'reused-pass' };

      await expect(service.changePassword('user-123', dto)).rejects.toThrow(
        /reuse a recent password/,
      );

      expect(mockPasswordHistoryService.assertNotReused).toHaveBeenCalledWith(
        'user-123',
        'reused-pass',
        fakeUser.password,
      );
      expect(mockedHash).not.toHaveBeenCalled();
      expect(mockPrismaService.user.update).not.toHaveBeenCalled();
    });

    it('hashes and saves the new password on success', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(fakeUser);
      mockedVerify.mockResolvedValue(true);
      mockedHash.mockResolvedValue('new-hashed-pw' as never);

      const dto = { currentPassword: 'correct-password', newPassword: 'newPass123' };

      await service.changePassword('user-123', dto);

      expect(mockedHash).toHaveBeenCalledWith('newPass123');
      // the replaced hash lands in the password history
      expect(mockPasswordHistoryService.record).toHaveBeenCalledWith(
        'user-123',
        fakeUser.password,
      );
      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { id: 'user-123' },
        data: { password: 'new-hashed-pw' },
      });
    });
  });

  // ─── getSessions ────────────────────────────────────────────────────────────

  describe('getSessions', () => {
    const fakeSessions = [
      {
        id: 'session-1',
        ip: '1.2.3.4',
        userAgent: 'Chrome',
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 1000),
      },
      {
        id: 'session-2',
        ip: '5.6.7.8',
        userAgent: 'Safari',
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 1000),
      },
    ];

    it('flags the session matching the refresh cookie sessionId as current', async () => {
      mockPrismaService.session.findMany.mockResolvedValue(fakeSessions);
      mockJwtService.verify.mockReturnValue({ sessionId: 'session-2' });

      const result = await service.getSessions('user-123', 'refresh-jwt');

      expect(mockPrismaService.session.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-123', expiresAt: { gt: expect.any(Date) } },
        }),
      );
      expect(result).toEqual([
        expect.objectContaining({ id: 'session-1', isCurrent: false }),
        expect.objectContaining({ id: 'session-2', isCurrent: true }),
      ]);
    });

    it('never selects the stored refresh token hash', async () => {
      mockPrismaService.session.findMany.mockResolvedValue(fakeSessions);
      mockJwtService.verify.mockReturnValue({ sessionId: 'session-1' });

      await service.getSessions('user-123', 'refresh-jwt');

      const args = mockPrismaService.session.findMany.mock.calls[0][0];
      expect(args.select).not.toHaveProperty('refreshToken');
    });

    it('flags nothing as current when no refresh cookie is provided', async () => {
      mockPrismaService.session.findMany.mockResolvedValue(fakeSessions);

      const result = await service.getSessions('user-123');

      expect(mockJwtService.verify).not.toHaveBeenCalled();
      expect(result.every((s) => s.isCurrent === false)).toBe(true);
    });

    it('flags nothing as current when the refresh cookie is invalid', async () => {
      mockPrismaService.session.findMany.mockResolvedValue(fakeSessions);
      mockJwtService.verify.mockImplementation(() => {
        throw new Error('invalid token');
      });

      const result = await service.getSessions('user-123', 'tampered-jwt');

      expect(result.every((s) => s.isCurrent === false)).toBe(true);
    });
  });

  // ─── revokeSession ──────────────────────────────────────────────────────────

  describe('revokeSession', () => {
    it('deletes the session when it belongs to the user', async () => {
      mockPrismaService.session.findUnique.mockResolvedValue({
        userId: 'user-123',
      });

      const result = await service.revokeSession('user-123', 'session-1');

      expect(mockPrismaService.session.delete).toHaveBeenCalledWith({
        where: { id: 'session-1' },
      });
      expect(result).toEqual({ message: 'Session revoked' });
    });

    it('throws NotFoundException when the session does not exist', async () => {
      mockPrismaService.session.findUnique.mockResolvedValue(null);

      await expect(
        service.revokeSession('user-123', 'missing'),
      ).rejects.toThrow(NotFoundException);
      expect(mockPrismaService.session.delete).not.toHaveBeenCalled();
    });

    it('throws the same NotFoundException when the session belongs to another user', async () => {
      mockPrismaService.session.findUnique.mockResolvedValue({
        userId: 'someone-else',
      });

      await expect(
        service.revokeSession('user-123', 'session-1'),
      ).rejects.toThrow(NotFoundException);
      expect(mockPrismaService.session.delete).not.toHaveBeenCalled();
    });
  });

  // ─── revokeOtherSessions ────────────────────────────────────────────────────

  describe('revokeOtherSessions', () => {
    it('deletes all sessions except the current one', async () => {
      mockJwtService.verify.mockReturnValue({ sessionId: 'session-current' });
      mockPrismaService.session.deleteMany.mockResolvedValue({ count: 3 });

      const result = await service.revokeOtherSessions('user-123', 'refresh-jwt');

      expect(mockPrismaService.session.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-123', id: { not: 'session-current' } },
      });
      expect(result).toEqual({ message: 'Other sessions revoked', count: 3 });
    });

    it('deletes every session when the refresh cookie cannot be resolved', async () => {
      mockJwtService.verify.mockImplementation(() => {
        throw new Error('invalid token');
      });
      mockPrismaService.session.deleteMany.mockResolvedValue({ count: 4 });

      const result = await service.revokeOtherSessions('user-123', 'bad-jwt');

      expect(mockPrismaService.session.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-123' },
      });
      expect(result.count).toBe(4);
    });
  });

  describe('getSignInMethods', () => {
    it('reports password status and de-duplicated providers', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({ password: 'hash' });
      mockPrismaService.account.findMany.mockResolvedValue([
        { provider: 'google' },
        { provider: 'google' },
      ]);

      const result = await service.getSignInMethods('user-123');

      expect(result).toEqual({ hasPassword: true, providers: ['google'] });
    });
  });

  describe('setPassword', () => {
    it('rejects when a password is already set', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        email: 'a@b.com',
        password: 'existing-hash',
      });

      await expect(service.setPassword('user-123', 'New1!pass')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrismaService.user.update).not.toHaveBeenCalled();
    });

    it('sets a hashed password and alerts the owner when none exists', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        email: 'a@b.com',
        password: null,
      });
      mockPasswordBreachService.isBreached.mockResolvedValue(false);
      mockedHash.mockResolvedValue('new-hash' as never);
      mockPrismaService.user.update.mockResolvedValue({});

      await service.setPassword('user-123', 'New1!pass');

      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { id: 'user-123' },
        data: { password: 'new-hash' },
      });
      expect(mockMailService.sendSignInMethodAddedEmail).toHaveBeenCalledWith(
        'a@b.com',
        expect.objectContaining({ method: 'Password' }),
      );
    });
  });

  describe('disconnectProvider', () => {
    it('refuses to remove the only remaining sign-in method', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({ password: null });
      mockPrismaService.account.findMany.mockResolvedValue([
        { provider: 'google' },
      ]);

      await expect(
        service.disconnectProvider('user-123', 'google'),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrismaService.account.deleteMany).not.toHaveBeenCalled();
    });

    it('disconnects when a password remains as a fallback', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({ password: 'hash' });
      mockPrismaService.account.findMany.mockResolvedValue([
        { provider: 'google' },
      ]);
      mockPrismaService.account.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.disconnectProvider('user-123', 'google');

      expect(mockPrismaService.account.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-123', provider: 'google' },
      });
      expect(result.message).toContain('disconnected');
    });
  });
});
