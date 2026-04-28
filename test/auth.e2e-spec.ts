import {
  BadRequestException,
  ConflictException,
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

describe('AuthController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
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

    it('returns 409 when email is already registered', () => {
      mockAuthService.registerUser.mockRejectedValue(
        new ConflictException('User already exists'),
      );
      return request(app.getHttpServer())
        .post('/auth/signup')
        .send(VALID_SIGNUP)
        .expect(409);
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
      });

      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send(VALID_LOGIN)
        .expect(200);

      expect(res.body.accessToken).toBe('access-token-123');
      expect(res.body).not.toHaveProperty('refreshToken');

      const cookies = res.headers['set-cookie'] as unknown as string[];
      expect(cookies.some((c) => c.startsWith('refreshToken='))).toBe(true);
      expect(cookies.some((c) => c.toLowerCase().includes('httponly'))).toBe(true);
    });
  });

  // ─── POST /auth/refresh ──────────────────────────────────────────────────────

  describe('POST /auth/refresh', () => {
    it('returns 401 when no refreshToken cookie is present', () => {
      return request(app.getHttpServer()).post('/auth/refresh').expect(401);
    });

    it('returns 401 when the refresh token is invalid', () => {
      mockAuthService.refresh.mockRejectedValue(
        new UnauthorizedException('Invalid refresh token'),
      );
      return request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', 'refreshToken=bad-token')
        .expect(401);
    });

    it('returns 200, returns new accessToken, and rotates the cookie', async () => {
      mockAuthService.refresh.mockResolvedValue({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
      });

      const res = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', 'refreshToken=old-refresh-token')
        .expect(200);

      expect(res.body.accessToken).toBe('new-access-token');

      const cookies = res.headers['set-cookie'] as unknown as string[];
      expect(cookies.some((c) => c.startsWith('refreshToken='))).toBe(true);
    });
  });

  // ─── POST /auth/logout ───────────────────────────────────────────────────────

  describe('POST /auth/logout', () => {
    it('returns 200 and clears the refreshToken cookie', async () => {
      mockAuthService.logout.mockResolvedValue({ message: 'Logged out successfully' });

      const res = await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Cookie', 'refreshToken=some-token')
        .expect(200);

      expect(res.body.message).toBe('Logged out successfully');

      const cookies = res.headers['set-cookie'] as unknown as string[];
      expect(cookies.some((c) => c.startsWith('refreshToken=;'))).toBe(true);
    });

    it('returns 200 even without a cookie (idempotent)', () => {
      return request(app.getHttpServer()).post('/auth/logout').expect(200);
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
