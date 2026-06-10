import {
  BadRequestException,
  INestApplication,
  NotFoundException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as cookieParser from 'cookie-parser';
import * as request from 'supertest';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { TwoFactorAuthService } from '../src/auth/two-factor-auth.service';

const VALID_SIGNUP = {
  firstname: 'John',
  lastname: 'Doe',
  email: 'john@example.com',
  password: 'Password1!',
  passwordRepeat: 'Password1!',
};

const VALID_LOGIN = {
  email: 'john@example.com',
  password: 'Password1!',
};

const mockAuthService = {
  registerUser: jest.fn(),
  loginUser: jest.fn(),
  refresh: jest.fn(),
  logout: jest.fn(),
  verifyEmail: jest.fn(),
  forgotPassword: jest.fn(),
  resetPassword: jest.fn(),
};

const mockTwoFactorAuthService = {
  generateAndStoreSecret: jest.fn(),
  enableTwoFactor: jest.fn(),
  disableTwoFactor: jest.fn(),
  verifyTwoFactorForLogin: jest.fn(),
};

describe('AuthController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
        { provide: TwoFactorAuthService, useValue: mockTwoFactorAuthService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(), getOrThrow: jest.fn() },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── POST /auth/signup ───────────────────────────────────────────────────────

  describe('POST /auth/signup', () => {
    it('returns 400 when required fields are missing', () => {
      return request(app.getHttpServer()).post('/auth/signup').send({}).expect(400);
    });

    it('returns 400 when email format is invalid', () => {
      return request(app.getHttpServer())
        .post('/auth/signup')
        .send({ ...VALID_SIGNUP, email: 'not-an-email' })
        .expect(400);
    });

    it('returns the same 200 success body for a duplicate email (no enumeration)', async () => {
      // The service resolves with the same generic message for duplicates;
      // the wire response must be indistinguishable from a fresh signup.
      mockAuthService.registerUser.mockResolvedValue({
        message:
          'Registration successful! Please check your email to verify your account.',
      });

      const res = await request(app.getHttpServer())
        .post('/auth/signup')
        .send(VALID_SIGNUP)
        .expect(200);

      expect(res.body).toEqual({
        message:
          'Registration successful! Please check your email to verify your account.',
      });
    });

    it('returns 400 with a clear error when the password is known-breached', async () => {
      mockAuthService.registerUser.mockRejectedValue(
        new BadRequestException(
          'This password has appeared in a known data breach. Please choose a different one.',
        ),
      );

      const res = await request(app.getHttpServer())
        .post('/auth/signup')
        .send(VALID_SIGNUP)
        .expect(400);

      expect(res.body.message).toContain('known data breach');
    });

    it('returns 200 and a success message on valid registration', async () => {
      mockAuthService.registerUser.mockResolvedValue({
        message:
          'Registration successful! Please check your email to verify your account.',
      });

      const res = await request(app.getHttpServer())
        .post('/auth/signup')
        .send(VALID_SIGNUP)
        .expect(200);

      expect(res.body.message).toContain('Registration successful');
    });
  });

  // ─── POST /auth/login ────────────────────────────────────────────────────────

  describe('POST /auth/login', () => {
    it('returns 400 when required fields are missing', () => {
      return request(app.getHttpServer()).post('/auth/login').send({}).expect(400);
    });

    it('returns 404 when user is not found', () => {
      mockAuthService.loginUser.mockRejectedValue(
        new NotFoundException('User not found. Please register first.'),
      );
      return request(app.getHttpServer())
        .post('/auth/login')
        .send(VALID_LOGIN)
        .expect(404);
    });

    it('returns 401 when credentials are invalid', () => {
      mockAuthService.loginUser.mockRejectedValue(
        new UnauthorizedException('Invalid credentials'),
      );
      return request(app.getHttpServer())
        .post('/auth/login')
        .send(VALID_LOGIN)
        .expect(401);
    });

    it('returns 200, sets httpOnly refreshToken cookie, and returns accessToken', async () => {
      mockAuthService.loginUser.mockResolvedValue({
        user: { id: 'user-123', email: 'john@example.com' },
        accessToken: 'access-token-123',
        refreshToken: 'refresh-token-123',
        rememberMe: false,
      });

      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send(VALID_LOGIN)
        .expect(200);

      expect(res.body.accessToken).toBe('access-token-123');
      expect(res.body).not.toHaveProperty('refreshToken');
      expect(res.body).not.toHaveProperty('rememberMe');

      const cookies = res.headers['set-cookie'] as unknown as string[];
      const refreshCookie = cookies.find((c) => c.startsWith('refreshToken='));
      expect(refreshCookie).toBeDefined();
      expect(refreshCookie!.toLowerCase()).toContain('httponly');
      // without rememberMe it is a session cookie — no Max-Age/Expires
      expect(refreshCookie!.toLowerCase()).not.toContain('max-age');

      // the double-submit CSRF cookie ships alongside, readable by the SPA
      const csrfCookie = cookies.find((c) => c.startsWith('csrfToken='));
      expect(csrfCookie).toBeDefined();
      expect(csrfCookie!.toLowerCase()).not.toContain('httponly');
      expect(csrfCookie!.toLowerCase()).not.toContain('max-age');
    });

    it('sets a persistent 30-day cookie when rememberMe was chosen', async () => {
      mockAuthService.loginUser.mockResolvedValue({
        user: { id: 'user-123', email: 'john@example.com' },
        accessToken: 'access-token-123',
        refreshToken: 'refresh-token-123',
        rememberMe: true,
      });

      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ ...VALID_LOGIN, rememberMe: true })
        .expect(200);

      expect(mockAuthService.loginUser).toHaveBeenCalledWith(
        expect.objectContaining({ rememberMe: true }),
        expect.anything(),
        undefined,
      );

      const cookies = res.headers['set-cookie'] as unknown as string[];
      const refreshCookie = cookies.find((c) => c.startsWith('refreshToken='));
      expect(refreshCookie).toContain('Max-Age=2592000'); // 30 days
      const csrfCookie = cookies.find((c) => c.startsWith('csrfToken='));
      expect(csrfCookie).toContain('Max-Age=2592000');
    });

    it('rejects a non-boolean rememberMe', () => {
      return request(app.getHttpServer())
        .post('/auth/login')
        .send({ ...VALID_LOGIN, rememberMe: 'yes' })
        .expect(400);
    });
  });

  // ─── POST /auth/refresh ──────────────────────────────────────────────────────

  describe('POST /auth/refresh', () => {
    // Double-submit CSRF pair used by the happy-path tests below.
    const CSRF_PAIR = {
      cookie: 'csrfToken=csrf-123',
      header: ['X-CSRF-Token', 'csrf-123'] as const,
    };

    it('returns 403 when the CSRF token is missing', () => {
      return request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', 'refreshToken=old-refresh-token')
        .expect(403);
    });

    it('returns 403 when the CSRF header does not match the cookie', () => {
      return request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', `refreshToken=old-refresh-token; ${CSRF_PAIR.cookie}`)
        .set('X-CSRF-Token', 'wrong-value')
        .expect(403);
    });

    it('returns 401 when no refreshToken cookie is present', () => {
      return request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', CSRF_PAIR.cookie)
        .set(...CSRF_PAIR.header)
        .expect(401);
    });

    it('returns 401 when the refresh token is invalid', () => {
      mockAuthService.refresh.mockRejectedValue(
        new UnauthorizedException('Invalid refresh token'),
      );
      return request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', `refreshToken=bad-token; ${CSRF_PAIR.cookie}`)
        .set(...CSRF_PAIR.header)
        .expect(401);
    });

    it('returns 200, returns new accessToken, and rotates both cookies', async () => {
      mockAuthService.refresh.mockResolvedValue({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        rememberMe: false,
      });

      const res = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', `refreshToken=old-refresh-token; ${CSRF_PAIR.cookie}`)
        .set(...CSRF_PAIR.header)
        .expect(200);

      expect(res.body.accessToken).toBe('new-access-token');

      const cookies = res.headers['set-cookie'] as unknown as string[];
      const refreshCookie = cookies.find((c) => c.startsWith('refreshToken='));
      expect(refreshCookie).toBeDefined();
      expect(refreshCookie!.toLowerCase()).not.toContain('max-age');
      // CSRF cookie rotates alongside and must stay readable by the SPA
      const csrfCookie = cookies.find((c) => c.startsWith('csrfToken='));
      expect(csrfCookie).toBeDefined();
      expect(csrfCookie!.toLowerCase()).not.toContain('httponly');
    });

    it('keeps the 30-day cookie lifetime for rememberMe sessions', async () => {
      mockAuthService.refresh.mockResolvedValue({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        rememberMe: true,
      });

      const res = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', `refreshToken=old-refresh-token; ${CSRF_PAIR.cookie}`)
        .set(...CSRF_PAIR.header)
        .expect(200);

      const cookies = res.headers['set-cookie'] as unknown as string[];
      const refreshCookie = cookies.find((c) => c.startsWith('refreshToken='));
      expect(refreshCookie).toContain('Max-Age=2592000');
    });
  });

  // ─── POST /auth/logout ───────────────────────────────────────────────────────

  describe('POST /auth/logout', () => {
    it('returns 403 when the CSRF token is missing', () => {
      return request(app.getHttpServer())
        .post('/auth/logout')
        .set('Cookie', 'refreshToken=some-token')
        .expect(403);
    });

    it('returns 200 and clears both auth cookies', async () => {
      mockAuthService.logout.mockResolvedValue({ message: 'Logged out successfully' });

      const res = await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Cookie', 'refreshToken=some-token; csrfToken=csrf-123')
        .set('X-CSRF-Token', 'csrf-123')
        .expect(200);

      expect(res.body.message).toBe('Logged out successfully');

      const cookies = res.headers['set-cookie'] as unknown as string[];
      expect(cookies.some((c) => c.startsWith('refreshToken=;'))).toBe(true);
      expect(cookies.some((c) => c.startsWith('csrfToken=;'))).toBe(true);
    });

    it('returns 200 without a refresh cookie when CSRF is valid (idempotent)', () => {
      return request(app.getHttpServer())
        .post('/auth/logout')
        .set('Cookie', 'csrfToken=csrf-123')
        .set('X-CSRF-Token', 'csrf-123')
        .expect(200);
    });
  });

  // ─── GET /auth/verify-email ──────────────────────────────────────────────────

  describe('GET /auth/verify-email', () => {
    it('returns 400 when the token is invalid', () => {
      mockAuthService.verifyEmail.mockRejectedValue(
        new BadRequestException('Invalid verification token'),
      );
      return request(app.getHttpServer())
        .get('/auth/verify-email?token=bad-token')
        .expect(400);
    });

    it('returns 400 when the token is expired', () => {
      mockAuthService.verifyEmail.mockRejectedValue(
        new BadRequestException('Verification token has expired.'),
      );
      return request(app.getHttpServer())
        .get('/auth/verify-email?token=expired-token')
        .expect(400);
    });

    it('returns 200 when the token is valid', async () => {
      mockAuthService.verifyEmail.mockResolvedValue({
        message: 'Email verified successfully. You can now log in.',
      });

      const res = await request(app.getHttpServer())
        .get('/auth/verify-email?token=valid-token')
        .expect(200);

      expect(res.body.message).toContain('Email verified');
    });
  });

  // ─── POST /auth/forgot-password ──────────────────────────────────────────────

  describe('POST /auth/forgot-password', () => {
    it('returns 400 when email format is invalid', () => {
      return request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'not-an-email' })
        .expect(400);
    });

    it('always returns 200 regardless of whether the email exists', async () => {
      mockAuthService.forgotPassword.mockResolvedValue({
        message:
          'If an account with this email exists, a password reset link has been sent.',
      });

      const res = await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'unknown@example.com' })
        .expect(200);

      expect(res.body.message).toContain(
        'If an account with this email exists',
      );
    });
  });

  // ─── POST /auth/reset-password ───────────────────────────────────────────────

  describe('POST /auth/reset-password', () => {
    it('returns 400 when required fields are missing', () => {
      return request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({})
        .expect(400);
    });

    it('returns 400 when the token is invalid or expired', () => {
      mockAuthService.resetPassword.mockRejectedValue(
        new BadRequestException('Invalid or expired reset token'),
      );
      return request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: 'bad-token', password: 'NewPass1!', passwordRepeat: 'NewPass1!' })
        .expect(400);
    });

    it('returns 400 with a clear error when the new password is known-breached', async () => {
      mockAuthService.resetPassword.mockRejectedValue(
        new BadRequestException(
          'This password has appeared in a known data breach. Please choose a different one.',
        ),
      );

      const res = await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({
          token: 'valid-token',
          password: 'Password1!',
          passwordRepeat: 'Password1!',
        })
        .expect(400);

      expect(res.body.message).toContain('known data breach');
    });

    it('returns 400 with a clear error when the new password was recently used', async () => {
      mockAuthService.resetPassword.mockRejectedValue(
        new BadRequestException(
          "You can't reuse a recent password. Please choose a different one.",
        ),
      );

      const res = await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({
          token: 'valid-token',
          password: 'Password1!',
          passwordRepeat: 'Password1!',
        })
        .expect(400);

      expect(res.body.message).toContain('reuse a recent password');
    });

    it('returns 200 on successful password reset', async () => {
      mockAuthService.resetPassword.mockResolvedValue({
        message:
          'Password reset successfully. You can now log in with your new password.',
      });

      const res = await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({
          token: 'valid-token',
          password: 'NewPass1!',
          passwordRepeat: 'NewPass1!',
        })
        .expect(200);

      expect(res.body.message).toContain('Password reset successfully');
    });
  });
});
