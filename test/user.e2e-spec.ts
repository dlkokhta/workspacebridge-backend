import {
  BadRequestException,
  ExecutionContext,
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as request from 'supertest';
import { UserController } from '../src/user/user.controller';
import { UserService } from '../src/user/user.service';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';

const mockUserService = {
  getProfile: jest.fn(),
  updateProfile: jest.fn(),
  changePassword: jest.fn(),
  getSessions: jest.fn(),
  revokeSession: jest.fn(),
  revokeOtherSessions: jest.fn(),
  getSignInMethods: jest.fn(),
  setPassword: jest.fn(),
  disconnectProvider: jest.fn(),
};

const FAKE_SESSIONS = [
  {
    id: 'session-1',
    ip: '1.2.3.4',
    userAgent: 'Chrome',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1000).toISOString(),
    isCurrent: true,
  },
  {
    id: 'session-2',
    ip: '5.6.7.8',
    userAgent: 'Safari',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1000).toISOString(),
    isCurrent: false,
  },
];

describe('UserController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [UserController],
      providers: [{ provide: UserService, useValue: mockUserService }],
    })
      // The JWT guard itself is covered by the auth e2e suite; here it is
      // replaced with a stub that injects a fixed authenticated user so the
      // session endpoints can be exercised in isolation.
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context
            .switchToHttp()
            .getRequest<{ user: { id: string; role: string } }>();
          req.user = { id: 'user-123', role: 'FREELANCER' };
          return true;
        },
      })
      .compile();

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

  // ─── GET /user/sessions ──────────────────────────────────────────────────────

  describe('PATCH /user/me/password', () => {
    const VALID_CHANGE = {
      currentPassword: 'OldPass1!',
      newPassword: 'NewPass1!',
    };

    it('changes the password and returns 200', async () => {
      mockUserService.changePassword.mockResolvedValue(undefined);

      await request(app.getHttpServer())
        .patch('/user/me/password')
        .send(VALID_CHANGE)
        .expect(200);

      expect(mockUserService.changePassword).toHaveBeenCalledWith(
        'user-123',
        VALID_CHANGE,
      );
    });

    it('returns 400 with a clear error when the new password is known-breached', async () => {
      mockUserService.changePassword.mockRejectedValue(
        new BadRequestException(
          'This password has appeared in a known data breach. Please choose a different one.',
        ),
      );

      const res = await request(app.getHttpServer())
        .patch('/user/me/password')
        .send(VALID_CHANGE)
        .expect(400);

      expect(res.body.message).toContain('known data breach');
    });

    it('returns 400 with a clear error when the new password was recently used', async () => {
      mockUserService.changePassword.mockRejectedValue(
        new BadRequestException(
          "You can't reuse a recent password. Please choose a different one.",
        ),
      );

      const res = await request(app.getHttpServer())
        .patch('/user/me/password')
        .send(VALID_CHANGE)
        .expect(400);

      expect(res.body.message).toContain('reuse a recent password');
    });
  });

  // ─── Sign-in methods (set-password / disconnect / list) ──────────────────────

  describe('GET /user/me/sign-in-methods', () => {
    it('returns hasPassword and linked providers', async () => {
      mockUserService.getSignInMethods.mockResolvedValue({
        hasPassword: false,
        providers: ['google'],
      });

      const res = await request(app.getHttpServer())
        .get('/user/me/sign-in-methods')
        .expect(200);

      expect(res.body).toEqual({ hasPassword: false, providers: ['google'] });
      expect(mockUserService.getSignInMethods).toHaveBeenCalledWith('user-123');
    });
  });

  describe('POST /user/me/password/set', () => {
    it('sets a password and returns 200', async () => {
      mockUserService.setPassword.mockResolvedValue(undefined);

      const res = await request(app.getHttpServer())
        .post('/user/me/password/set')
        .send({ newPassword: 'BrandNew1!' })
        .expect(200);

      expect(res.body.message).toContain('Password set');
      expect(mockUserService.setPassword).toHaveBeenCalledWith(
        'user-123',
        'BrandNew1!',
      );
    });

    it('returns 400 for a weak password (DTO validation)', () => {
      return request(app.getHttpServer())
        .post('/user/me/password/set')
        .send({ newPassword: 'weak' })
        .expect(400);
    });

    it('returns 400 when a password already exists', async () => {
      mockUserService.setPassword.mockRejectedValue(
        new BadRequestException('A password is already set.'),
      );

      return request(app.getHttpServer())
        .post('/user/me/password/set')
        .send({ newPassword: 'BrandNew1!' })
        .expect(400);
    });
  });

  describe('DELETE /user/me/accounts/:provider', () => {
    it('disconnects a provider and returns 200', async () => {
      mockUserService.disconnectProvider.mockResolvedValue({
        message: 'google disconnected',
      });

      const res = await request(app.getHttpServer())
        .delete('/user/me/accounts/Google')
        .expect(200);

      expect(res.body.message).toContain('disconnected');
      // provider is lower-cased by the controller before the service call.
      expect(mockUserService.disconnectProvider).toHaveBeenCalledWith(
        'user-123',
        'google',
      );
    });

    it('returns 400 when it is the only sign-in method', async () => {
      mockUserService.disconnectProvider.mockRejectedValue(
        new BadRequestException(
          "You can't disconnect your only sign-in method. Set a password first.",
        ),
      );

      return request(app.getHttpServer())
        .delete('/user/me/accounts/google')
        .expect(400);
    });
  });

  describe('GET /user/sessions', () => {
    it('returns the session list and forwards the refresh cookie', async () => {
      mockUserService.getSessions.mockResolvedValue(FAKE_SESSIONS);

      const res = await request(app.getHttpServer())
        .get('/user/sessions')
        .set('Cookie', ['refreshToken=refresh-jwt'])
        .expect(200);

      expect(mockUserService.getSessions).toHaveBeenCalledWith(
        'user-123',
        'refresh-jwt',
      );
      expect(res.body).toHaveLength(2);
      expect(res.body[0]).toMatchObject({ id: 'session-1', isCurrent: true });
    });

    it('works without a refresh cookie (no session flagged current)', async () => {
      mockUserService.getSessions.mockResolvedValue([]);

      await request(app.getHttpServer()).get('/user/sessions').expect(200);

      expect(mockUserService.getSessions).toHaveBeenCalledWith(
        'user-123',
        undefined,
      );
    });
  });

  // ─── DELETE /user/sessions/:id ───────────────────────────────────────────────

  describe('DELETE /user/sessions/:id', () => {
    it('revokes the given session', async () => {
      mockUserService.revokeSession.mockResolvedValue({
        message: 'Session revoked',
      });

      const res = await request(app.getHttpServer())
        .delete('/user/sessions/session-2')
        .expect(200);

      expect(mockUserService.revokeSession).toHaveBeenCalledWith(
        'user-123',
        'session-2',
      );
      expect(res.body).toEqual({ message: 'Session revoked' });
    });

    it('returns 404 when the session is unknown or not owned', async () => {
      mockUserService.revokeSession.mockRejectedValue(
        new NotFoundException('Session not found'),
      );

      await request(app.getHttpServer())
        .delete('/user/sessions/not-mine')
        .expect(404);
    });
  });

  // ─── DELETE /user/sessions ───────────────────────────────────────────────────

  describe('DELETE /user/sessions', () => {
    it('revokes all other sessions and forwards the refresh cookie', async () => {
      mockUserService.revokeOtherSessions.mockResolvedValue({
        message: 'Other sessions revoked',
        count: 2,
      });

      const res = await request(app.getHttpServer())
        .delete('/user/sessions')
        .set('Cookie', ['refreshToken=refresh-jwt'])
        .expect(200);

      expect(mockUserService.revokeOtherSessions).toHaveBeenCalledWith(
        'user-123',
        'refresh-jwt',
      );
      expect(res.body).toEqual({ message: 'Other sessions revoked', count: 2 });
    });
  });
});
