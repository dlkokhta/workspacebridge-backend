/* eslint-disable
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-argument
*/
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { UserRole } from '@prisma/client';
import { SearchController } from '../src/search/search.controller';
import { SearchService } from '../src/search/search.service';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';

const mockSearchService = {
  search: jest.fn(),
};

// Stands in for JwtAuthGuard: always authenticates as a fixed freelancer.
const fakeUser = { id: 'user-1', role: UserRole.FREELANCER };
const fakeGuard = {
  canActivate: (ctx: ExecutionContext) => {
    ctx.switchToHttp().getRequest().user = fakeUser;
    return true;
  },
};

describe('SearchController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [SearchController],
      providers: [{ provide: SearchService, useValue: mockSearchService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(fakeGuard)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchService.search.mockResolvedValue({
      query: 'logo',
      total: 0,
      results: [],
    });
  });

  describe('GET /search (global)', () => {
    it('passes the user and query through without a workspaceId', async () => {
      await request(app.getHttpServer())
        .get('/search')
        .query({ q: 'logo' })
        .expect(200);

      expect(mockSearchService.search).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          role: UserRole.FREELANCER,
          q: 'logo',
          limit: 20,
        }),
      );
      expect(
        mockSearchService.search.mock.calls[0][0].workspaceId,
      ).toBeUndefined();
    });

    it('rejects a query shorter than 2 characters', async () => {
      await request(app.getHttpServer())
        .get('/search')
        .query({ q: 'a' })
        .expect(400);
      expect(mockSearchService.search).not.toHaveBeenCalled();
    });

    it('rejects a missing query', async () => {
      await request(app.getHttpServer()).get('/search').expect(400);
      expect(mockSearchService.search).not.toHaveBeenCalled();
    });

    it('rejects a limit above 50', async () => {
      await request(app.getHttpServer())
        .get('/search')
        .query({ q: 'logo', limit: 999 })
        .expect(400);
    });

    it('rejects an unknown type', async () => {
      await request(app.getHttpServer())
        .get('/search')
        .query({ q: 'logo', types: 'nonsense' })
        .expect(400);
    });

    it('parses comma-separated types into an array', async () => {
      await request(app.getHttpServer())
        .get('/search')
        .query({ q: 'logo', types: 'message,file' })
        .expect(200);
      expect(mockSearchService.search.mock.calls[0][0].types).toEqual([
        'message',
        'file',
      ]);
    });
  });

  describe('GET /workspace/:id/search (scoped)', () => {
    it('forwards the workspaceId from the path', async () => {
      await request(app.getHttpServer())
        .get('/workspace/ws-42/search')
        .query({ q: 'invoice' })
        .expect(200);
      expect(mockSearchService.search).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'ws-42', q: 'invoice' }),
      );
    });
  });
});
