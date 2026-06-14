import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { UserService } from '../user/user.service';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { ConfigService } from '@nestjs/config';
import { PasswordBreachService } from '../libs/common/services/password-breach.service';
import { PasswordHistoryService } from '../libs/common/services/password-history.service';
import { LoginAlertService } from './login-alert.service';
import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { createHash } from 'crypto';

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

jest.mock('argon2');

const mockedHash = argon2.hash as jest.MockedFunction<typeof argon2.hash>;
const mockedVerify = argon2.verify as jest.MockedFunction<typeof argon2.verify>;

const fakeUser = {
  id: 'user-123',
  firstname: 'John',
  lastname: 'Doe',
  email: 'john@example.com',
  password: 'hashed-password',
  role: 'FREELANCER',
  picture: null,
  method: 'CREDENTIALS',
  status: 'ACTIVE',
  isVerified: true,
  isTwoFactorEnabled: false,
  twoFactorSecret: null,
  failedLoginAttempts: 0,
  lockedUntil: null,
  createdAt: new Date(),
};

const mockUserService = {
  findByEmail: jest.fn(),
  findById: jest.fn(),
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
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  },
  account: {
    create: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  twoFactorAttempt: {
    create: jest.fn(),
  },
  auditLog: {
    create: jest.fn().mockResolvedValue({}),
  },
  $transaction: jest.fn(),
};

const mockMailService = {
  sendVerificationEmail: jest.fn(),
  sendPasswordResetEmail: jest.fn(),
  sendAccountExistsEmail: jest.fn().mockResolvedValue(undefined),
  sendEmailChangeVerification: jest.fn().mockResolvedValue(undefined),
  sendEmailChangedAlert: jest.fn().mockResolvedValue(undefined),
  sendSignInMethodAddedEmail: jest.fn().mockResolvedValue(undefined),
};

const mockPasswordBreachService = {
  isBreached: jest.fn().mockResolvedValue(false),
};

const mockPasswordHistoryService = {
  assertNotReused: jest.fn(),
  record: jest.fn(),
};

const mockLoginAlertService = {
  handleSuccessfulLogin: jest.fn(),
};

const mockConfigService = {
  getOrThrow: jest.fn((key: string) => {
    const map: Record<string, string> = { JWT_SECRET: 'test-secret' };
    return map[key];
  }),
  get: jest.fn((key: string) => {
    const map: Record<string, string> = {
      JWT_REFRESH_SECRET: 'test-refresh-secret',
      JWT_ACCESS_EXPIRES_IN: '15m',
      JWT_REFRESH_EXPIRES_IN: '7d',
    };
    return map[key];
  }),
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
        { provide: ConfigService, useValue: mockConfigService },
        { provide: PasswordBreachService, useValue: mockPasswordBreachService },
        {
          provide: PasswordHistoryService,
          useValue: mockPasswordHistoryService,
        },
        { provide: LoginAlertService, useValue: mockLoginAlertService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jest.clearAllMocks();
  });

  // ─── registerUser ───────────────────────────────────────────────────────────

  describe('registerUser', () => {
    const SIGNUP_DTO = {
      email: 'john@example.com',
      password: 'pass',
      passwordRepeat: 'pass',
      firstname: 'John',
      lastname: 'Doe',
    };

    it('returns the same success message for a duplicate email (no enumeration)', async () => {
      mockUserService.findByEmail.mockResolvedValue(fakeUser);

      const result = await service.registerUser(SIGNUP_DTO);

      expect(result).toEqual({
        message:
          'Registration successful! Please check your email to verify your account.',
      });
      // nothing is created and no verification email goes out
      expect(mockUserService.create).not.toHaveBeenCalled();
      expect(mockMailService.sendVerificationEmail).not.toHaveBeenCalled();
      // the real owner is told by email and the attempt is audited
      expect(mockMailService.sendAccountExistsEmail).toHaveBeenCalledWith(
        fakeUser.email,
      );
      expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'auth.register_duplicate',
          targetId: fakeUser.id,
        }),
      });
    });

    it('rejects a breached password before the duplicate-email lookup', async () => {
      mockPasswordBreachService.isBreached.mockResolvedValueOnce(true);

      await expect(service.registerUser(SIGNUP_DTO)).rejects.toThrow(
        new BadRequestException(
          'This password has appeared in a known data breach. Please choose a different one.',
        ),
      );

      expect(mockPasswordBreachService.isBreached).toHaveBeenCalledWith(
        SIGNUP_DTO.password,
      );
      // The check runs first so the 400 is identical whether or not the
      // email is registered — no enumeration channel via breached passwords.
      expect(mockUserService.findByEmail).not.toHaveBeenCalled();
      expect(mockUserService.create).not.toHaveBeenCalled();
      expect(mockMailService.sendVerificationEmail).not.toHaveBeenCalled();
      expect(mockMailService.sendAccountExistsEmail).not.toHaveBeenCalled();
    });

    it('does not fail the duplicate path when the email send fails', async () => {
      mockUserService.findByEmail.mockResolvedValue(fakeUser);
      mockMailService.sendAccountExistsEmail.mockRejectedValueOnce(
        new Error('resend down'),
      );

      const result = await service.registerUser(SIGNUP_DTO);

      expect(result.message).toContain('Registration successful');
    });

    it('creates user, sends verification email, and returns a message', async () => {
      mockUserService.findByEmail.mockResolvedValue(null);
      mockUserService.create.mockResolvedValue(fakeUser);
      mockPrismaService.token.deleteMany.mockResolvedValue({});
      mockPrismaService.token.create.mockResolvedValue({});
      mockMailService.sendVerificationEmail.mockResolvedValue(undefined);

      const result = await service.registerUser(SIGNUP_DTO);

      expect(mockUserService.create).toHaveBeenCalled();
      expect(mockMailService.sendVerificationEmail).toHaveBeenCalledWith(
        fakeUser.email,
        expect.any(String),
      );
      expect(result.message).toContain('Registration successful');
      // response must be byte-identical to the duplicate path — in
      // particular no user object (the Prisma user carries the hash)
      expect(result).not.toHaveProperty('user');
      expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: 'auth.register' }),
      });
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

      // The plaintext token from the link is hashed before the DB lookup —
      // only the hash is ever stored.
      expect(mockPrismaService.token.findUnique).toHaveBeenCalledWith({
        where: { token: sha256('valid-token') },
      });
      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { email: 'john@example.com' },
        data: { isVerified: true },
      });
      expect(result.message).toContain('Email verified');
    });
  });

  // ─── resendVerification ───────────────────────────────────────────────────────

  describe('resendVerification', () => {
    const safeMessage =
      'If an account with this email exists and is unverified, a new verification link has been sent.';

    it('returns the safe message and sends nothing for an unknown email', async () => {
      mockUserService.findByEmail.mockResolvedValue(null);

      const result = await service.resendVerification('unknown@example.com');
      await new Promise((resolve) => setImmediate(resolve));

      expect(result.message).toBe(safeMessage);
      expect(mockMailService.sendVerificationEmail).not.toHaveBeenCalled();
      expect(mockPrismaService.token.create).not.toHaveBeenCalled();
    });

    it('skips an already-verified account but still returns the safe message', async () => {
      mockUserService.findByEmail.mockResolvedValue(fakeUser); // isVerified: true

      const result = await service.resendVerification('john@example.com');
      await new Promise((resolve) => setImmediate(resolve));

      expect(result.message).toBe(safeMessage);
      expect(mockMailService.sendVerificationEmail).not.toHaveBeenCalled();
    });

    it('skips a Google account (no password to verify)', async () => {
      mockUserService.findByEmail.mockResolvedValue({
        ...fakeUser,
        isVerified: false,
        method: 'GOOGLE',
      });

      const result = await service.resendVerification('john@example.com');
      await new Promise((resolve) => setImmediate(resolve));

      expect(result.message).toBe(safeMessage);
      expect(mockMailService.sendVerificationEmail).not.toHaveBeenCalled();
    });

    it('creates a fresh token (stored hashed) and emails an unverified user', async () => {
      mockUserService.findByEmail.mockResolvedValue({
        ...fakeUser,
        isVerified: false,
      });
      mockPrismaService.token.deleteMany.mockResolvedValue({});
      mockPrismaService.token.create.mockResolvedValue({});
      mockMailService.sendVerificationEmail.mockResolvedValue(undefined);

      const result = await service.resendVerification('john@example.com');
      await new Promise((resolve) => setImmediate(resolve));

      expect(result.message).toBe(safeMessage);
      // The DB stores the hash; the email carries the matching plaintext.
      const created = mockPrismaService.token.create.mock.calls[0][0] as {
        data: { token: string; type: string };
      };
      const emailedToken = mockMailService.sendVerificationEmail.mock
        .calls[0][1] as string;
      expect(created.data.type).toBe('VERIFICATION');
      expect(created.data.token).toBe(sha256(emailedToken));
      expect(created.data.token).not.toBe(emailedToken);
    });
  });

  // ─── loginUser ──────────────────────────────────────────────────────────────

  describe('loginUser', () => {
    it('throws generic Invalid credentials when user is not found', async () => {
      mockUserService.findByEmail.mockResolvedValue(null);
      mockedHash.mockResolvedValue('dummy-hash' as never);
      mockedVerify.mockResolvedValue(false);

      await expect(
        service.loginUser({ email: 'nobody@example.com', password: 'pass' }),
      ).rejects.toThrow(
        new UnauthorizedException('Invalid credentials'),
      );
    });

    it('throws generic Invalid credentials for Google-only accounts', async () => {
      mockUserService.findByEmail.mockResolvedValue({ ...fakeUser, method: 'GOOGLE', password: null });
      mockedHash.mockResolvedValue('dummy-hash' as never);
      mockedVerify.mockResolvedValue(false);

      await expect(
        service.loginUser({ email: 'john@example.com', password: 'pass' }),
      ).rejects.toThrow(
        new UnauthorizedException('Invalid credentials'),
      );
    });

    it('throws UnauthorizedException when password is incorrect', async () => {
      mockUserService.findByEmail.mockResolvedValue(fakeUser);
      mockedVerify.mockResolvedValue(false);
      mockPrismaService.user.update.mockResolvedValue({ failedLoginAttempts: 1 });

      await expect(
        service.loginUser({ email: 'john@example.com', password: 'wrong' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a locked account before verifying the password', async () => {
      mockUserService.findByEmail.mockResolvedValue({
        ...fakeUser,
        lockedUntil: new Date(Date.now() + 10 * 60 * 1000),
      });

      await expect(
        service.loginUser(
          { email: 'john@example.com', password: 'correct' },
          '1.2.3.4',
          'Chrome',
        ),
      ).rejects.toThrow(/temporarily locked/);

      // the password oracle must stay closed during the lockout window
      expect(mockedVerify).not.toHaveBeenCalled();
      expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'auth.login_failed',
          targetId: 'user-123',
          ip: '1.2.3.4',
          metadata: expect.objectContaining({
            reason: 'account_locked',
          }),
        }),
      });
    });

    it('verifies the password normally once the lock has expired', async () => {
      mockUserService.findByEmail.mockResolvedValue({
        ...fakeUser,
        lockedUntil: new Date(Date.now() - 1000),
        failedLoginAttempts: 5,
      });
      mockedVerify.mockResolvedValue(true);
      mockedHash.mockResolvedValue('hashed-refresh' as never);
      mockJwtService.sign
        .mockReturnValueOnce('access-token')
        .mockReturnValueOnce('refresh-token');
      mockPrismaService.session.findMany.mockResolvedValue([]);
      mockPrismaService.session.create.mockResolvedValue({});
      mockPrismaService.user.update.mockResolvedValue({});

      const result = await service.loginUser({
        email: 'john@example.com',
        password: 'correct',
      });

      expect(mockedVerify).toHaveBeenCalled();
      expect(result).toHaveProperty('accessToken', 'access-token');
      // stale counters reset after the successful login
      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { id: 'user-123' },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    });

    it('locks the account and says so on the 5th failed attempt', async () => {
      mockUserService.findByEmail.mockResolvedValue(fakeUser);
      mockedVerify.mockResolvedValue(false);
      mockPrismaService.user.update
        .mockResolvedValueOnce({ failedLoginAttempts: 5 })
        .mockResolvedValueOnce({});

      await expect(
        service.loginUser({ email: 'john@example.com', password: 'wrong' }),
      ).rejects.toThrow(
        new UnauthorizedException(
          'Too many failed attempts. Account is locked for 15 minutes.',
        ),
      );

      // second update applies the lock
      expect(mockPrismaService.user.update).toHaveBeenCalledTimes(2);
      expect(
        mockPrismaService.user.update.mock.calls[1][0].data.lockedUntil,
      ).toBeInstanceOf(Date);
      expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'auth.account_locked',
          metadata: expect.objectContaining({ attempts: 5 }),
        }),
      });
    });

    it('audits below-threshold failures and stays generic', async () => {
      mockUserService.findByEmail.mockResolvedValue(fakeUser);
      mockedVerify.mockResolvedValue(false);
      mockPrismaService.user.update.mockResolvedValue({
        failedLoginAttempts: 2,
      });

      await expect(
        service.loginUser({ email: 'john@example.com', password: 'wrong' }),
      ).rejects.toThrow(new UnauthorizedException('Invalid credentials'));

      expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'auth.login_failed',
          metadata: expect.objectContaining({
            reason: 'wrong_password',
            attempts: 2,
          }),
        }),
      });
    });

    it('throws UnauthorizedException when email is not verified', async () => {
      mockUserService.findByEmail.mockResolvedValue({ ...fakeUser, isVerified: false });
      mockedVerify.mockResolvedValue(true);

      await expect(
        service.loginUser({ email: 'john@example.com', password: 'pass' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when account is suspended', async () => {
      mockUserService.findByEmail.mockResolvedValue({ ...fakeUser, status: 'SUSPENDED' });
      mockedVerify.mockResolvedValue(true);

      await expect(
        service.loginUser({ email: 'john@example.com', password: 'pass' }),
      ).rejects.toThrow(new UnauthorizedException('Account is suspended'));
    });

    it('returns tokens and user without password on successful login', async () => {
      mockUserService.findByEmail.mockResolvedValue(fakeUser);
      mockedVerify.mockResolvedValue(true);
      mockedHash.mockResolvedValue('hashed-refresh' as never);
      mockJwtService.sign
        .mockReturnValueOnce('access-token')
        .mockReturnValueOnce('refresh-token');
      mockPrismaService.session.findMany.mockResolvedValue([]);
      mockPrismaService.session.create.mockResolvedValue({});
      mockPrismaService.user.update.mockResolvedValue({});

      const result = await service.loginUser({
        email: 'john@example.com',
        password: 'correct',
      });

      expect(result).toHaveProperty('accessToken', 'access-token');
      expect(result).toHaveProperty('refreshToken', 'refresh-token');
      expect((result as { user: Record<string, unknown> }).user).not.toHaveProperty('password');
      expect(mockPrismaService.session.create).toHaveBeenCalled();
      // completed login → new-device check + success audit
      expect(mockLoginAlertService.handleSuccessfulLogin).toHaveBeenCalledWith(
        'auth.login',
        expect.objectContaining({ userId: 'user-123' }),
      );
    });

    it('defaults to a 1-day session without rememberMe', async () => {
      mockUserService.findByEmail.mockResolvedValue(fakeUser);
      mockedVerify.mockResolvedValue(true);
      mockedHash.mockResolvedValue('hashed-refresh' as never);
      mockJwtService.sign
        .mockReturnValueOnce('access-token')
        .mockReturnValueOnce('refresh-token');
      mockPrismaService.session.findMany.mockResolvedValue([]);
      mockPrismaService.session.create.mockResolvedValue({});

      const result = await service.loginUser({
        email: 'john@example.com',
        password: 'correct',
      });

      expect(result).toHaveProperty('rememberMe', false);
      // refresh JWT carries the choice and is signed for 1 day
      const [refreshPayload, refreshOptions] = mockJwtService.sign.mock.calls[1];
      expect(refreshPayload).toMatchObject({ rememberMe: false });
      expect(refreshOptions).toMatchObject({ expiresIn: 24 * 60 * 60 });
      // session row expires ~1 day out
      const sessionData = mockPrismaService.session.create.mock.calls[0][0].data;
      const ttl = sessionData.expiresAt.getTime() - Date.now();
      expect(ttl).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
      expect(ttl).toBeGreaterThan(23 * 60 * 60 * 1000);
    });

    it('creates a 30-day session when rememberMe is requested', async () => {
      mockUserService.findByEmail.mockResolvedValue(fakeUser);
      mockedVerify.mockResolvedValue(true);
      mockedHash.mockResolvedValue('hashed-refresh' as never);
      mockJwtService.sign
        .mockReturnValueOnce('access-token')
        .mockReturnValueOnce('refresh-token');
      mockPrismaService.session.findMany.mockResolvedValue([]);
      mockPrismaService.session.create.mockResolvedValue({});

      const result = await service.loginUser({
        email: 'john@example.com',
        password: 'correct',
        rememberMe: true,
      });

      expect(result).toHaveProperty('rememberMe', true);
      const [refreshPayload, refreshOptions] = mockJwtService.sign.mock.calls[1];
      expect(refreshPayload).toMatchObject({ rememberMe: true });
      expect(refreshOptions).toMatchObject({ expiresIn: 30 * 24 * 60 * 60 });
      const sessionData = mockPrismaService.session.create.mock.calls[0][0].data;
      const ttl = sessionData.expiresAt.getTime() - Date.now();
      expect(ttl).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    });

    it('carries the rememberMe choice into the 2FA pre-auth token', async () => {
      mockUserService.findByEmail.mockResolvedValue({
        ...fakeUser,
        isTwoFactorEnabled: true,
      });
      mockedVerify.mockResolvedValue(true);
      mockJwtService.sign.mockReturnValueOnce('temp-token');
      mockPrismaService.twoFactorAttempt.create.mockResolvedValue({});

      const result = await service.loginUser({
        email: 'john@example.com',
        password: 'correct',
        rememberMe: true,
      });

      expect(result).toEqual({ requiresTwoFactor: true, tempToken: 'temp-token' });
      expect(mockJwtService.sign.mock.calls[0][0]).toMatchObject({
        rememberMe: true,
      });
      // the password step is not a completed login — no alert/audit yet;
      // it fires after 2FA verification instead
      expect(mockLoginAlertService.handleSuccessfulLogin).not.toHaveBeenCalled();
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
        role: 'FREELANCER',
        sessionId: 'session-1',
      });
      mockPrismaService.session.findUnique.mockResolvedValue(null);

      await expect(service.refresh('unmatched-token')).rejects.toThrow(
        new UnauthorizedException('Refresh token not found'),
      );
    });

    it('throws UnauthorizedException when session is expired', async () => {
      mockJwtService.verify.mockReturnValue({
        userId: 'user-123',
        email: 'john@example.com',
        role: 'FREELANCER',
        sessionId: 'session-1',
      });
      mockPrismaService.session.findUnique.mockResolvedValue({
        id: 'session-1',
        userId: 'user-123',
        refreshToken: 'hashed-token',
        previousRefreshToken: null,
        tokenRotatedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      });
      mockedVerify.mockResolvedValue(true);

      await expect(service.refresh('expired-token')).rejects.toThrow(
        new UnauthorizedException('Refresh token expired'),
      );
    });

    it('rotates the session and returns new tokens on success', async () => {
      mockJwtService.verify.mockReturnValue({
        userId: 'user-123',
        email: 'john@example.com',
        role: 'FREELANCER',
        sessionId: 'session-1',
      });
      mockPrismaService.session.findUnique.mockResolvedValue({
        id: 'session-1',
        userId: 'user-123',
        refreshToken: 'hashed-token',
        previousRefreshToken: null,
        tokenRotatedAt: null,
        expiresAt: new Date(Date.now() + 10000),
      });
      mockedVerify.mockResolvedValue(true);
      mockPrismaService.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });
      mockJwtService.sign
        .mockReturnValueOnce('new-access')
        .mockReturnValueOnce('new-refresh');
      mockedHash.mockResolvedValue('new-hashed-refresh' as never);
      mockPrismaService.session.update.mockResolvedValue({});

      const result = await service.refresh('valid-refresh-token');

      expect(result).toEqual({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        rememberMe: false,
      });
      expect(mockPrismaService.session.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'session-1' } }),
      );
    });

    it('preserves the rememberMe choice across rotation', async () => {
      mockJwtService.verify.mockReturnValue({
        userId: 'user-123',
        email: 'john@example.com',
        role: 'FREELANCER',
        sessionId: 'session-1',
        rememberMe: true,
      });
      mockPrismaService.session.findUnique.mockResolvedValue({
        id: 'session-1',
        userId: 'user-123',
        refreshToken: 'hashed-token',
        previousRefreshToken: null,
        tokenRotatedAt: null,
        expiresAt: new Date(Date.now() + 10000),
      });
      mockedVerify.mockResolvedValue(true);
      mockPrismaService.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });
      mockJwtService.sign
        .mockReturnValueOnce('new-access')
        .mockReturnValueOnce('new-refresh');
      mockedHash.mockResolvedValue('new-hashed-refresh' as never);
      mockPrismaService.session.update.mockResolvedValue({});

      const result = await service.refresh('valid-refresh-token');

      expect(result).toMatchObject({ rememberMe: true });
      // new refresh JWT keeps the flag and the 30-day expiry
      const [refreshPayload, refreshOptions] = mockJwtService.sign.mock.calls[1];
      expect(refreshPayload).toMatchObject({ rememberMe: true });
      expect(refreshOptions).toMatchObject({ expiresIn: 30 * 24 * 60 * 60 });
      // session row extended ~30 days out
      const updateData = mockPrismaService.session.update.mock.calls[0][0].data;
      expect(updateData.expiresAt.getTime() - Date.now()).toBeGreaterThan(
        29 * 24 * 60 * 60 * 1000,
      );
    });
  });

  // ─── logout ─────────────────────────────────────────────────────────────────

  describe('logout', () => {
    it('deletes the session for the token', async () => {
      mockJwtService.verify.mockReturnValue({ userId: 'user-123', sessionId: 'session-1' });
      mockPrismaService.session.delete.mockResolvedValue({});

      const result = await service.logout('valid-refresh-token');

      expect(mockPrismaService.session.delete).toHaveBeenCalledWith({
        where: { id: 'session-1' },
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
    });

    it('returns the same safe message when user email is not verified', async () => {
      mockUserService.findByEmail.mockResolvedValue({ ...fakeUser, isVerified: false });

      const result = await service.forgotPassword('john@example.com');

      expect(result.message).toBe(safeMessage);
    });

    it('creates a reset token and sends email for a valid verified user', async () => {
      mockUserService.findByEmail.mockResolvedValue(fakeUser);
      mockPrismaService.token.deleteMany.mockResolvedValue({});
      mockPrismaService.token.create.mockResolvedValue({});
      mockMailService.sendPasswordResetEmail.mockResolvedValue(undefined);

      const result = await service.forgotPassword('john@example.com');

      await new Promise((resolve) => setImmediate(resolve));

      expect(mockMailService.sendPasswordResetEmail).toHaveBeenCalledWith(
        'john@example.com',
        expect.any(String),
      );
      expect(result.message).toBe(safeMessage);
    });
  });

  // ─── resetPassword ──────────────────────────────────────────────────────────

  describe('resetPassword', () => {
    it('rejects a breached password without consuming the reset token', async () => {
      mockPasswordBreachService.isBreached.mockResolvedValueOnce(true);

      await expect(
        service.resetPassword('valid-token', 'breached-pass'),
      ).rejects.toThrow(
        new BadRequestException(
          'This password has appeared in a known data breach. Please choose a different one.',
        ),
      );

      // The single-use token must survive so the user can retry with a
      // stronger password from the same reset link.
      expect(mockPrismaService.token.delete).not.toHaveBeenCalled();
      expect(mockPrismaService.$transaction).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when token is not found', async () => {
      mockPrismaService.token.findUnique.mockResolvedValue(null);

      await expect(service.resetPassword('bad-token', 'newPass')).rejects.toThrow(
        new BadRequestException('Invalid or expired reset token'),
      );
      expect(mockPrismaService.token.delete).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when token is expired', async () => {
      mockPrismaService.token.findUnique.mockResolvedValue({
        email: 'john@example.com',
        expiresIn: new Date(Date.now() - 1000),
      });

      await expect(service.resetPassword('expired-token', 'newPass')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects a reused password without consuming the reset token', async () => {
      mockPrismaService.token.findUnique.mockResolvedValue({
        email: 'john@example.com',
        expiresIn: new Date(Date.now() + 10000),
      });
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user-123',
        password: 'old-hash',
      });
      mockPasswordHistoryService.assertNotReused.mockRejectedValueOnce(
        new BadRequestException(
          "You can't reuse a recent password. Please choose a different one.",
        ),
      );

      await expect(
        service.resetPassword('valid-token', 'reused-pass'),
      ).rejects.toThrow(/reuse a recent password/);

      // The single-use token must survive a policy rejection.
      expect(mockPrismaService.token.delete).not.toHaveBeenCalled();
      expect(mockPrismaService.$transaction).not.toHaveBeenCalled();
    });

    it('hashes new password, records history, invalidates all sessions atomically on success', async () => {
      mockPrismaService.token.findUnique.mockResolvedValue({
        email: 'john@example.com',
        expiresIn: new Date(Date.now() + 10000),
      });
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user-123',
        password: 'old-hash',
      });
      mockPrismaService.token.delete.mockResolvedValue({});
      mockedHash.mockResolvedValue('new-hashed-pw' as never);
      mockPrismaService.$transaction.mockResolvedValue([{}, {}]);

      const result = await service.resetPassword('valid-token', 'newPass123');

      expect(mockPasswordHistoryService.assertNotReused).toHaveBeenCalledWith(
        'user-123',
        'newPass123',
        'old-hash',
      );
      expect(mockPrismaService.token.delete).toHaveBeenCalledWith({
        where: { token: sha256('valid-token') },
      });
      expect(mockedHash).toHaveBeenCalledWith('newPass123');
      expect(mockPasswordHistoryService.record).toHaveBeenCalledWith(
        'user-123',
        'old-hash',
      );
      expect(mockPrismaService.$transaction).toHaveBeenCalled();
      expect(result.message).toContain('Password reset successfully');
    });
  });

  // ─── requestEmailChange ───────────────────────────────────────────────────────

  describe('requestEmailChange', () => {
    it('rejects when the password is incorrect', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user-123',
        email: 'john@example.com',
        password: 'old-hash',
      });
      mockedVerify.mockResolvedValue(false);

      await expect(
        service.requestEmailChange('user-123', 'new@example.com', 'wrong'),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockMailService.sendEmailChangeVerification).not.toHaveBeenCalled();
    });

    it('rejects when the new email is already in use', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user-123',
        email: 'john@example.com',
        password: 'old-hash',
      });
      mockedVerify.mockResolvedValue(true);
      mockUserService.findByEmail.mockResolvedValue({ id: 'someone-else' });

      await expect(
        service.requestEmailChange('user-123', 'taken@example.com', 'correct'),
      ).rejects.toThrow(ConflictException);
      expect(mockMailService.sendEmailChangeVerification).not.toHaveBeenCalled();
    });

    it('stores a hashed EMAIL_CHANGE token for the new address and emails it', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user-123',
        email: 'john@example.com',
        password: 'old-hash',
      });
      mockedVerify.mockResolvedValue(true);
      mockUserService.findByEmail.mockResolvedValue(null);
      mockPrismaService.token.deleteMany.mockResolvedValue({});
      mockPrismaService.token.create.mockResolvedValue({});

      const result = await service.requestEmailChange(
        'user-123',
        'new@example.com',
        'correct',
      );

      const created = mockPrismaService.token.create.mock.calls[0][0] as {
        data: { token: string; type: string; email: string; userId: string };
      };
      const emailedToken = mockMailService.sendEmailChangeVerification.mock
        .calls[0][1] as string;
      expect(created.data.type).toBe('EMAIL_CHANGE');
      expect(created.data.email).toBe('new@example.com');
      expect(created.data.userId).toBe('user-123');
      expect(created.data.token).toBe(sha256(emailedToken));
      expect(created.data.token).not.toBe(emailedToken);
      expect(result.message).toContain('confirmation link has been sent');
    });
  });

  // ─── confirmEmailChange ───────────────────────────────────────────────────────

  describe('confirmEmailChange', () => {
    it('rejects a token that is not an EMAIL_CHANGE token', async () => {
      mockPrismaService.token.findUnique.mockResolvedValue({
        type: 'VERIFICATION',
        email: 'new@example.com',
        userId: 'user-123',
        expiresIn: new Date(Date.now() + 10000),
      });

      await expect(service.confirmEmailChange('tok')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrismaService.user.update).not.toHaveBeenCalled();
    });

    it('switches the email, alerts the old address, and consumes the token', async () => {
      mockPrismaService.token.findUnique.mockResolvedValue({
        type: 'EMAIL_CHANGE',
        email: 'new@example.com',
        userId: 'user-123',
        expiresIn: new Date(Date.now() + 10000),
      });
      mockPrismaService.user.findUnique
        .mockResolvedValueOnce({ id: 'user-123', email: 'john@example.com' }) // by id
        .mockResolvedValueOnce(null); // new email not taken
      mockPrismaService.user.update.mockResolvedValue({});
      mockPrismaService.token.delete.mockResolvedValue({});

      const result = await service.confirmEmailChange('tok');
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { id: 'user-123' },
        data: { email: 'new@example.com' },
      });
      expect(mockMailService.sendEmailChangedAlert).toHaveBeenCalledWith(
        'john@example.com',
        'new@example.com',
      );
      expect(mockPrismaService.token.delete).toHaveBeenCalledWith({
        where: { token: sha256('tok') },
      });
      expect(result.message).toContain('updated successfully');
    });

    it('rejects when the new address was taken since the request', async () => {
      mockPrismaService.token.findUnique.mockResolvedValue({
        type: 'EMAIL_CHANGE',
        email: 'new@example.com',
        userId: 'user-123',
        expiresIn: new Date(Date.now() + 10000),
      });
      mockPrismaService.user.findUnique
        .mockResolvedValueOnce({ id: 'user-123', email: 'john@example.com' })
        .mockResolvedValueOnce({ id: 'other-user' }); // new email now taken
      mockPrismaService.token.delete.mockResolvedValue({});

      await expect(service.confirmEmailChange('tok')).rejects.toThrow(
        ConflictException,
      );
      expect(mockPrismaService.user.update).not.toHaveBeenCalled();
    });
  });

  // ─── findOrCreateGoogleUser (secure linking) ──────────────────────────────────

  describe('findOrCreateGoogleUser', () => {
    const googleUser = {
      googleId: 'google-sub-1',
      email: 'g@example.com',
      emailVerified: true,
      firstName: 'G',
      lastName: 'User',
    };

    // loginGoogleUser issues a real session — wire its dependencies.
    const setupSessionIssuance = () => {
      mockJwtService.sign.mockReturnValue('signed-token');
      mockedHash.mockResolvedValue('hashed' as never);
      mockPrismaService.session.findMany.mockResolvedValue([]);
      mockPrismaService.session.create.mockResolvedValue({});
    };

    it('refuses an unverified Google email', async () => {
      await expect(
        service.findOrCreateGoogleUser({ ...googleUser, emailVerified: false }),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockPrismaService.user.create).not.toHaveBeenCalled();
    });

    it('matches a returning user by Google sub without creating anything', async () => {
      setupSessionIssuance();
      mockPrismaService.account.findFirst.mockResolvedValue({
        user: { id: 'u1', email: 'g@example.com', role: 'FREELANCER' },
      });
      mockUserService.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'g@example.com',
        role: 'FREELANCER',
        status: 'ACTIVE',
      });

      const result = await service.findOrCreateGoogleUser(googleUser);

      expect(result.accessToken).toBe('signed-token');
      expect(mockPrismaService.user.create).not.toHaveBeenCalled();
      expect(mockPrismaService.account.create).not.toHaveBeenCalled();
    });

    it('refuses to link to an unverified local account (anti pre-hijacking)', async () => {
      mockPrismaService.account.findFirst.mockResolvedValue(null);
      mockUserService.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'g@example.com',
        isVerified: false,
      });

      await expect(service.findOrCreateGoogleUser(googleUser)).rejects.toThrow(
        ConflictException,
      );
      expect(mockPrismaService.account.create).not.toHaveBeenCalled();
    });

    it('links a verified local account and alerts the owner', async () => {
      setupSessionIssuance();
      mockPrismaService.account.findFirst.mockResolvedValue(null);
      mockUserService.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'g@example.com',
        role: 'FREELANCER',
        status: 'ACTIVE',
        isVerified: true,
      });
      mockPrismaService.account.create.mockResolvedValue({});

      const result = await service.findOrCreateGoogleUser(googleUser);

      expect(mockPrismaService.account.create).toHaveBeenCalled();
      expect(mockMailService.sendSignInMethodAddedEmail).toHaveBeenCalledWith(
        'g@example.com',
        expect.objectContaining({ method: 'Google' }),
      );
      expect(result.accessToken).toBe('signed-token');
    });

    it('creates a brand-new Google user (no password, verified) when none exists', async () => {
      setupSessionIssuance();
      mockPrismaService.account.findFirst.mockResolvedValue(null);
      // step 2 lookup → none; loginGoogleUser lookup → the freshly created user.
      mockUserService.findByEmail
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'u2',
          email: 'g@example.com',
          role: 'FREELANCER',
          status: 'ACTIVE',
        });
      mockPrismaService.user.create.mockResolvedValue({
        id: 'u2',
        email: 'g@example.com',
      });
      mockPrismaService.account.create.mockResolvedValue({});

      const result = await service.findOrCreateGoogleUser(googleUser);

      const created = mockPrismaService.user.create.mock.calls[0][0] as {
        data: { method: string; isVerified: boolean; password: null };
      };
      expect(created.data.method).toBe('GOOGLE');
      expect(created.data.isVerified).toBe(true);
      expect(created.data.password).toBeNull();
      expect(result.accessToken).toBe('signed-token');
    });
  });
});
