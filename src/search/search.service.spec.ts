import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { SearchService } from './search.service';
import { PrismaService } from '../prisma/prisma.service';

const mockPrisma = {
  $queryRaw: jest.fn(),
  workspace: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
};

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'rec-1',
  workspaceId: 'ws-1',
  title: 'Title',
  snippet: 'snippet',
  rank: 0.5,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  authorId: null,
  authorFirstname: null,
  authorLastname: null,
  authorEmail: null,
  parentId: null,
  ...over,
});

describe('SearchService', () => {
  let service: SearchService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(SearchService);
    jest.clearAllMocks();
    mockPrisma.$queryRaw.mockResolvedValue([]);
  });

  describe('scoped access control', () => {
    it('throws NotFoundException when the workspace does not exist', async () => {
      mockPrisma.workspace.findUnique.mockResolvedValue(null);
      await expect(
        service.search({
          userId: 'u1',
          role: UserRole.FREELANCER,
          workspaceId: 'ws-1',
          q: 'hello',
          limit: 20,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when the user is neither owner nor member', async () => {
      mockPrisma.workspace.findUnique.mockResolvedValue({
        id: 'ws-1',
        name: 'Acme',
        ownerId: 'someone-else',
        members: [],
      });
      await expect(
        service.search({
          userId: 'u1',
          role: UserRole.CLIENT,
          workspaceId: 'ws-1',
          q: 'hello',
          limit: 20,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('allows a member and scopes the search to the one workspace', async () => {
      mockPrisma.workspace.findUnique.mockResolvedValue({
        id: 'ws-1',
        name: 'Acme',
        ownerId: 'owner',
        members: [{ id: 'm1' }],
      });
      const res = await service.search({
        userId: 'u1',
        role: UserRole.CLIENT,
        workspaceId: 'ws-1',
        q: 'hello',
        limit: 20,
      });
      expect(res.query).toBe('hello');
      expect(mockPrisma.workspace.findMany).not.toHaveBeenCalled();
    });
  });

  describe('source selection', () => {
    beforeEach(() => {
      mockPrisma.workspace.findUnique.mockResolvedValue({
        id: 'ws-1',
        name: 'Acme',
        ownerId: 'u1',
        members: [],
      });
    });

    it('queries all 7 sources for a freelancer', async () => {
      await service.search({
        userId: 'u1',
        role: UserRole.FREELANCER,
        workspaceId: 'ws-1',
        q: 'hello',
        limit: 20,
      });
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(7);
    });

    it('never queries private tasks for a client (6 sources)', async () => {
      mockPrisma.workspace.findUnique.mockResolvedValue({
        id: 'ws-1',
        name: 'Acme',
        ownerId: 'owner',
        members: [{ id: 'm1' }],
      });
      await service.search({
        userId: 'client-1',
        role: UserRole.CLIENT,
        workspaceId: 'ws-1',
        q: 'hello',
        limit: 20,
      });
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(6);
    });

    it('does not query private tasks for a client even when explicitly requested', async () => {
      mockPrisma.workspace.findUnique.mockResolvedValue({
        id: 'ws-1',
        name: 'Acme',
        ownerId: 'owner',
        members: [{ id: 'm1' }],
      });
      await service.search({
        userId: 'client-1',
        role: UserRole.CLIENT,
        workspaceId: 'ws-1',
        q: 'hello',
        types: ['private_task'],
        limit: 20,
      });
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('queries only the requested types', async () => {
      await service.search({
        userId: 'u1',
        role: UserRole.FREELANCER,
        workspaceId: 'ws-1',
        q: 'hello',
        types: ['message', 'file'],
        limit: 20,
      });
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(2);
    });
  });

  describe('global search', () => {
    it('spans every accessible workspace', async () => {
      mockPrisma.workspace.findMany.mockResolvedValue([
        { id: 'ws-1', name: 'Acme' },
        { id: 'ws-2', name: 'Globex' },
      ]);
      await service.search({
        userId: 'u1',
        role: UserRole.FREELANCER,
        q: 'hello',
        limit: 20,
      });
      expect(mockPrisma.workspace.findMany).toHaveBeenCalled();
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(7);
    });

    it('returns no results and runs no source queries when the user has no workspaces', async () => {
      mockPrisma.workspace.findMany.mockResolvedValue([]);
      const res = await service.search({
        userId: 'lonely',
        role: UserRole.FREELANCER,
        q: 'hello',
        limit: 20,
      });
      expect(res.results).toHaveLength(0);
      expect(res.total).toBe(0);
    });
  });

  describe('result shaping', () => {
    beforeEach(() => {
      mockPrisma.workspace.findUnique.mockResolvedValue({
        id: 'ws-1',
        name: 'Acme',
        ownerId: 'u1',
        members: [],
      });
    });

    it('merges sources, ranks high-to-low and attaches the workspace name', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([row({ id: 'low', rank: 0.1 })]) // messages
        .mockResolvedValueOnce([row({ id: 'high', rank: 0.9 })]) // files
        .mockResolvedValue([]);
      const res = await service.search({
        userId: 'u1',
        role: UserRole.FREELANCER,
        workspaceId: 'ws-1',
        q: 'hello',
        types: ['message', 'file'],
        limit: 20,
      });
      expect(res.results.map((r) => r.id)).toEqual(['high', 'low']);
      expect(res.results[0].workspaceName).toBe('Acme');
      expect(res.results[0].type).toBe('file');
    });

    it('caps results at the requested limit', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        row({ id: 'a', rank: 0.3 }),
        row({ id: 'b', rank: 0.2 }),
        row({ id: 'c', rank: 0.1 }),
      ]);
      const res = await service.search({
        userId: 'u1',
        role: UserRole.FREELANCER,
        workspaceId: 'ws-1',
        q: 'hello',
        types: ['message'],
        limit: 2,
      });
      expect(res.results).toHaveLength(2);
      expect(res.total).toBe(2);
    });

    it('maps author fields when present and null when absent', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        row({
          id: 'with-author',
          authorId: 'a1',
          authorFirstname: 'Ada',
          authorLastname: 'Lovelace',
          authorEmail: 'ada@example.com',
        }),
      ]);
      const res = await service.search({
        userId: 'u1',
        role: UserRole.FREELANCER,
        workspaceId: 'ws-1',
        q: 'hello',
        types: ['message'],
        limit: 20,
      });
      expect(res.results[0].author).toEqual({
        id: 'a1',
        firstname: 'Ada',
        lastname: 'Lovelace',
        email: 'ada@example.com',
      });
    });
  });
});
