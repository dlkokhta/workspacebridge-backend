/* eslint-disable
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-argument
*/
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import * as cookieParser from 'cookie-parser';
import * as jwt from 'jsonwebtoken';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Multi-tenant isolation — the #1 trust property of the product: a client must
 * never be able to read another client's workspace or any of its sub-resources.
 *
 * This boots the real AppModule (real JwtAuthGuard + RolesGuard + services +
 * Postgres) and seeds two tenants owned by one freelancer:
 *
 *   Client A  ── member of ──>  Workspace A
 *   Client B  ── member of ──>  Workspace B
 *
 * then asserts that each client can reach only their own workspace. Tokens are
 * minted with the configured JWT_SECRET exactly as AuthService signs them
 * ({ userId, email, role }); the guard re-loads the user from the DB and the
 * services enforce ownership/membership — so this exercises the real
 * authorization path, not a mock of it.
 *
 * Requires the Postgres dev DB to be up (docker compose up -d). All seeded rows
 * are namespaced with a run-scoped suffix and removed in afterAll.
 */
describe('Workspace multi-tenant isolation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let secret: string;

  // Run-scoped suffix so re-runs never collide on the unique email column.
  const run = Date.now().toString(36);
  const ids = { freelancer: '', clientA: '', clientB: '', wsA: '', wsB: '' };
  let tokenA = '';
  let tokenB = '';

  const auth = (token: string) => ['Authorization', `Bearer ${token}`] as const;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    secret = app.get(ConfigService).getOrThrow<string>('JWT_SECRET');

    const freelancer = await prisma.user.create({
      data: { email: `iso-free-${run}@e2e.local`, role: UserRole.FREELANCER },
    });
    const clientA = await prisma.user.create({
      data: { email: `iso-c1-${run}@e2e.local`, role: UserRole.CLIENT },
    });
    const clientB = await prisma.user.create({
      data: { email: `iso-c2-${run}@e2e.local`, role: UserRole.CLIENT },
    });
    const wsA = await prisma.workspace.create({
      data: { name: `iso-A-${run}`, ownerId: freelancer.id },
    });
    const wsB = await prisma.workspace.create({
      data: { name: `iso-B-${run}`, ownerId: freelancer.id },
    });
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId: wsA.id, userId: clientA.id },
        { workspaceId: wsB.id, userId: clientB.id },
      ],
    });

    Object.assign(ids, {
      freelancer: freelancer.id,
      clientA: clientA.id,
      clientB: clientB.id,
      wsA: wsA.id,
      wsB: wsB.id,
    });

    const mint = (userId: string, email: string) =>
      jwt.sign({ userId, email, role: UserRole.CLIENT }, secret, {
        expiresIn: '15m',
      });
    tokenA = mint(clientA.id, clientA.email);
    tokenB = mint(clientB.id, clientB.email);
  });

  afterAll(async () => {
    // Workspaces cascade-delete their members; users go last (owner FK).
    await prisma.workspace.deleteMany({
      where: { id: { in: [ids.wsA, ids.wsB] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [ids.freelancer, ids.clientA, ids.clientB] } },
    });
    await app.close();
  });

  describe("a client cannot reach another tenant's workspace (403)", () => {
    // Client A is a member of Workspace A only; every Workspace B route must
    // be forbidden for them — across the workspace itself and each sub-resource.
    it.each([
      ['GET /workspace/:id (single)', (id: string) => `/workspace/${id}`],
      ['GET .../files', (id: string) => `/workspace/${id}/files`],
      ['GET .../links', (id: string) => `/workspace/${id}/links`],
      ['GET .../shared-tasks', (id: string) => `/workspace/${id}/shared-tasks`],
      ['GET .../whiteboards', (id: string) => `/workspace/${id}/whiteboards`],
      ['GET .../search', (id: string) => `/workspace/${id}/search?q=test`],
    ])('client A is denied workspace B — %s', (_label, path) =>
      request(app.getHttpServer())
        .get(path(ids.wsB))
        .set(...auth(tokenA))
        .expect(403),
    );

    it('reverse direction: client B is denied workspace A', () =>
      request(app.getHttpServer())
        .get(`/workspace/${ids.wsA}`)
        .set(...auth(tokenB))
        .expect(403));

    it('reverse direction: client B is denied workspace A files', () =>
      request(app.getHttpServer())
        .get(`/workspace/${ids.wsA}/files`)
        .set(...auth(tokenB))
        .expect(403));
  });

  describe('positive control — own workspace is reachable (200)', () => {
    // Proves the 403s above are isolation, not a blanket failure.
    it('client A reaches workspace A', () =>
      request(app.getHttpServer())
        .get(`/workspace/${ids.wsA}`)
        .set(...auth(tokenA))
        .expect(200)
        .expect((res) => expect(res.body.id).toBe(ids.wsA)));

    it('client B reaches workspace B', () =>
      request(app.getHttpServer())
        .get(`/workspace/${ids.wsB}`)
        .set(...auth(tokenB))
        .expect(200)
        .expect((res) => expect(res.body.id).toBe(ids.wsB)));
  });

  describe("the list endpoint returns only the caller's own workspaces", () => {
    it('client A list contains A and not B', async () => {
      const res = await request(app.getHttpServer())
        .get('/workspace')
        .set(...auth(tokenA))
        .expect(200);
      const list = (res.body as Array<{ id: string }>).map((w) => w.id);
      expect(list).toContain(ids.wsA);
      expect(list).not.toContain(ids.wsB);
    });

    it('client B list contains B and not A', async () => {
      const res = await request(app.getHttpServer())
        .get('/workspace')
        .set(...auth(tokenB))
        .expect(200);
      const list = (res.body as Array<{ id: string }>).map((w) => w.id);
      expect(list).toContain(ids.wsB);
      expect(list).not.toContain(ids.wsA);
    });
  });

  describe('the auth guard is active', () => {
    it('rejects an unauthenticated request', () =>
      request(app.getHttpServer()).get(`/workspace/${ids.wsA}`).expect(401));
  });
});
