import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { UserService } from '../user/user.service';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
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

const mockUserService = {
  findByEmail: jest.fn(),
  create: jest.fn(),
};

const mockJwtService = {
  sign: jest.fn(),
  verify: jest.fn(),
};

const mockPrismaService = {
  token: {
    findUnique: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  },
  user: {
    update: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
  },
  session: {
    create: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    deleteMany: jest.fn(),
  },
  account: {
    create: jest.fn(),
  },
};

const mockMailService = {
  sendVerificationEmail: jest.fn(),
  sendPasswordResetEmail: jest.fn(),
};

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: mockUserService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: MailService, useValue: mockMailService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jest.clearAllMocks();
  });

  // ─── registerUser ───────────────────────────────────────────────────────────

  describe('registerUser', () => {
    it('throws ConflictException when email is already registered', async () => {
      mockUserService.findByEmail.mockResolvedValue(fakeUser);

      await expect(
        service.registerUser({
          email: 'john@example.com',
          password: 'pass',
          passwordRepeat: 'pass',
          firstname: 'John',
          lastname: 'Doe',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('creates user, sends verification email, and returns a message', async () => {
      mockUserService.findByEmail.mockResolvedValue(null);
      mockUserService.create.mockResolvedValue(fakeUser);
      mockPrismaService.token.deleteMany.mockResolvedValue({});
      mockPrismaService.token.create.mockResolvedValue({});
      mockMailService.sendVerificationEmail.mockResolvedValue(undefined);

      const result = await service.registerUser({
        email: 'john@example.com',
        password: 'pass',
        passwordRepeat: 'pass',
        firstname: 'John',
        lastname: 'Doe',
      });

      expect(mockUserService.create).toHaveBeenCalled();
      expect(mockMailService.sendVerificationEmail).toHaveBeenCalledWith(
        fakeUser.email,
        expect.any(String),
      );
      expect(result.message).toContain('Registration successful');
    });
  });

  // ─── verifyEmail ────────────────────────────────────────────────────────────

  describe('verifyEmail', () => {
    it('throws BadRequestException when token is not found', async () => {
      mockPrismaService.token.findUnique.mockResolvedValue(null);

      await expect(service.verifyEmail('bad-token')).rejects.toThrow(
        new BadRequestException('Invalid verification token'),
      );
    });

    it('throws BadRequestException when token is the wrong type', async () => {
      mockPrismaService.token.findUnique.mockResolvedValue({
        token: 'some-token',
        type: 'PASSWORD_RESET',
        email: 'john@example.com',
        expiresIn: new Date(Date.now() + 10000),
      });

      await expect(service.verifyEmail('some-token')).rejects.toThrow(
        new BadRequestException('Invalid verification token'),
      );
    });

    it('throws BadRequestException when token is expired', async () => {
      mockPrismaService.token.findUnique.mockResolvedValue({
        token: 'expired-token',
        type: 'VERIFICATION',
        email: 'john@example.com',
        expiresIn: new Date(Date.now() - 1000),
      });
      mockPrismaService.token.delete.mockResolvedValue({});

      await expect(service.verifyEmail('expired-token')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('marks user as verified and returns success message', async () => {
      mockPrismaService.token.findUnique.mockResolvedValue({
        token: 'valid-token',
        type: 'VERIFICATION',
        email: 'john@example.com',
        expiresIn: new Date(Date.now() + 10000),
      });
      mockPrismaService.user.update.mockResolvedValue({});
      mockPrismaService.token.delete.mockResolvedValue({});

      const result = await service.verifyEmail('valid-token');

      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { email: 'john@example.com' },
        data: { isVerified: true },
      });
      expect(result.message).toContain('Email verified');
    });
  });

  // ─── loginUser ──────────────────────────────────────────────────────────────

  describe('loginUser', () => {
    it('throws NotFoundException when user is not found', async () => {
      mockUserService.findByEmail.mockResolvedValue(null);

      await expect(
        service.loginUser({ email: 'nobody@example.com', password: 'pass' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws UnauthorizedException for Google account users', async () => {
      mockUserService.findByEmail.mockResolvedValue({ ...fakeUser, method: 'GOOGLE' });

      await expect(
        service.loginUser({ email: 'john@example.com', password: 'pass' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when password is incorrect', async () => {
      mockUserService.findByEmail.mockResolvedValue(fakeUser);
      mockedVerify.mockResolvedValue(false);

      await expect(
        service.loginUser({ email: 'john@example.com', password: 'wrong' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when email is not verified', async () => {
      mockUserService.findByEmail.mockResolvedValue({ ...fakeUser, isVerified: false });
      mockedVerify.mockResolvedValue(true);

      await expect(
        service.loginUser({ email: 'john@example.com', password: 'pass' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('returns tokens and user without password on successful login', async () => {
      mockUserService.findByEmail.mockResolvedValue(fakeUser);
      mockedVerify.mockResolvedValue(true);
      mockedHash.mockResolvedValue('hashed-refresh' as never);
      mockJwtService.sign
        .mockReturnValueOnce('access-token')
        .mockReturnValueOnce('refresh-token');
      mockPrismaService.session.create.mockResolvedValue({});

      const result = await service.loginUser({
        email: 'john@example.com',
        password: 'correct',
      });

      expect(result).toHaveProperty('accessToken', 'access-token');
      expect(result).toHaveProperty('refreshToken', 'refresh-token');
      expect(result.user).not.toHaveProperty('password');
      expect(mockPrismaService.session.create).toHaveBeenCalled();
    });
  });

  // ─── refresh ────────────────────────────────────────────────────────────────

  describe('refresh', () => {
    it('throws UnauthorizedException when JWT is invalid', async () => {
      mockJwtService.verify.mockImplementation(() => {
        throw new Error('invalid');
      });

      await expect(service.refresh('bad-token')).rejects.toThrow(
        new UnauthorizedException('Invalid refresh token'),
      );
    });

    it('throws UnauthorizedException when no session matches the token', async () => {
      mockJwtService.verify.mockReturnValue({
        userId: 'user-123',
        email: 'john@example.com',
        role: 'USER',
      });
      mockPrismaService.session.findMany.mockResolvedValue([
        {
          id: 'session-1',
          refreshToken: 'hashed-other',
          expiresAt: new Date(Date.now() + 10000),
        },
      ]);
      mockedVerify.mockResolvedValue(false);

      await expect(service.refresh('unmatched-token')).rejects.toThrow(
        new UnauthorizedException('Refresh token not found'),
      );
    });

    it('throws UnauthorizedException when session is expired', async () => {
      mockJwtService.verify.mockReturnValue({
        userId: 'user-123',
        email: 'john@example.com',
        role: 'USER',
      });
      mockPrismaService.session.findMany.mockResolvedValue([
        {
          id: 'session-1',
          refreshToken: 'hashed-token',
          expiresAt: new Date(Date.now() - 1000),
        },
      ]);
      mockedVerify.mockResolvedValue(true);

      await expect(service.refresh('expired-token')).rejects.toThrow(
        new UnauthorizedException('Refresh token expired'),
      );
    });

    it('rotates the session and returns new tokens on success', async () => {
      mockJwtService.verify.mockReturnValue({
        userId: 'user-123',
        email: 'john@example.com',
        role: 'USER',
      });
      mockPrismaService.session.findMany.mockResolvedValue([
        {
          id: 'session-1',
          refreshToken: 'hashed-token',
          expiresAt: new Date(Date.now() + 10000),
        },
      ]);
      mockedVerify.mockResolvedValue(true);
      mockJwtService.sign
        .mockReturnValueOnce('new-access')
        .mockReturnValueOnce('new-refresh');
      mockedHash.mockResolvedValue('new-hashed-refresh' as never);
      mockPrismaService.session.update.mockResolvedValue({});

      const result = await service.refresh('valid-refresh-token');

      expect(result).toEqual({ accessToken: 'new-access', refreshToken: 'new-refresh' });
      expect(mockPrismaService.session.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'session-1' } }),
      );
    });
  });

  // ─── logout ─────────────────────────────────────────────────────────────────

  describe('logout', () => {
    it('deletes all sessions for the user', async () => {
      mockJwtService.verify.mockReturnValue({ userId: 'user-123' });
      mockPrismaService.session.deleteMany.mockResolvedValue({});

      const result = await service.logout('valid-refresh-token');

      expect(mockPrismaService.session.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-123' },
      });
      expect(result.message).toBe('Logged out successfully');
    });

    it('returns success even when token is invalid (idempotent)', async () => {
      mockJwtService.verify.mockImplementation(() => {
        throw new Error('invalid');
      });

      const result = await service.logout('invalid-token');

      expect(result.message).toBe('Logged out successfully');
    });
  });

  // ─── forgotPassword ─────────────────────────────────────────────────────────

  describe('forgotPassword', () => {
    const safeMessage =
      'If an account with this email exists, a password reset link has been sent.';

    it('returns the same safe message when user is not found (prevents enumeration)', async () => {
      mockUserService.findByEmail.mockResolvedValue(null);

      const result = await service.forgotPassword('unknown@example.com');

      expect(result.message).toBe(safeMessage);
      expect(mockMailService.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('returns the same safe message when user email is not verified', async () => {
      mockUserService.findByEmail.mockResolvedValue({ ...fakeUser, isVerified: false });

      const result = await service.forgotPassword('john@example.com');

      expect(result.message).toBe(safeMessage);
      expect(mockMailService.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('creates a reset token and sends email for a valid verified user', async () => {
      mockUserService.findByEmail.mockResolvedValue(fakeUser);
      mockPrismaService.token.deleteMany.mockResolvedValue({});
      mockPrismaService.token.create.mockResolvedValue({});
      mockMailService.sendPasswordResetEmail.mockResolvedValue(undefined);

      const result = await service.forgotPassword('john@example.com');

      expect(mockMailService.sendPasswordResetEmail).toHaveBeenCalledWith(
        'john@example.com',
        expect.any(String),
      );
      expect(result.message).toBe(safeMessage);
    });
  });

  // ─── resetPassword ──────────────────────────────────────────────────────────

  describe('resetPassword', () => {
    it('throws BadRequestException when token is not found', async () => {
      mockPrismaService.token.findUnique.mockResolvedValue(null);

      await expect(service.resetPassword('bad-token', 'newPass')).rejects.toThrow(
        new BadRequestException('Invalid or expired reset token'),
      );
    });

    it('throws BadRequestException when token is the wrong type', async () => {
      mockPrismaService.token.findUnique.mockResolvedValue({
        token: 'some-token',
        type: 'VERIFICATION',
        email: 'john@example.com',
        expiresIn: new Date(Date.now() + 10000),
      });

      await expect(service.resetPassword('some-token', 'newPass')).rejects.toThrow(
        new BadRequestException('Invalid or expired reset token'),
      );
    });

    it('throws BadRequestException when token is expired', async () => {
      mockPrismaService.token.findUnique.mockResolvedValue({
        token: 'expired-token',
        type: 'PASSWORD_RESET',
        email: 'john@example.com',
        expiresIn: new Date(Date.now() - 1000),
      });
      mockPrismaService.token.delete.mockResolvedValue({});

      await expect(service.resetPassword('expired-token', 'newPass')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('hashes new password, invalidates all sessions, and deletes token on success', async () => {
      mockPrismaService.token.findUnique.mockResolvedValue({
        token: 'valid-token',
        type: 'PASSWORD_RESET',
        email: 'john@example.com',
        expiresIn: new Date(Date.now() + 10000),
      });
      mockedHash.mockResolvedValue('new-hashed-pw' as never);
      mockPrismaService.user.update.mockResolvedValue({});
      mockPrismaService.user.findUnique.mockResolvedValue(fakeUser);
      mockPrismaService.session.deleteMany.mockResolvedValue({});
      mockPrismaService.token.delete.mockResolvedValue({});

      const result = await service.resetPassword('valid-token', 'newPass123');

      expect(mockedHash).toHaveBeenCalledWith('newPass123');
      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { email: 'john@example.com' },
        data: { password: 'new-hashed-pw' },
      });
      expect(mockPrismaService.session.deleteMany).toHaveBeenCalledWith({
        where: { userId: fakeUser.id },
      });
      expect(mockPrismaService.token.delete).toHaveBeenCalledWith({
        where: { token: 'valid-token' },
      });
      expect(result.message).toContain('Password reset successfully');
    });
  });
});
