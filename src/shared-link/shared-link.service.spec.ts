/* eslint-disable
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/unbound-method
*/
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { SharedLinkService } from './shared-link.service';
import { SharedLinkGateway } from './shared-link.gateway';
import { PrismaService } from '../prisma/prisma.service';

const mockPrismaService = {
  workspace: {
    findUnique: jest.fn(),
  },
  sharedLink: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
  },
};

const mockSharedLinkGateway = {
  emitLinkCreated: jest.fn(),
  emitLinkDeleted: jest.fn(),
};

const workspaceWithMember = (userId: string, ownerId = 'owner-1') => ({
  ownerId,
  members: [{ id: 'member-1', userId }],
});

describe('SharedLinkService', () => {
  let service: SharedLinkService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SharedLinkService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: SharedLinkGateway, useValue: mockSharedLinkGateway },
      ],
    }).compile();

    service = module.get<SharedLinkService>(SharedLinkService);
    jest.clearAllMocks();
  });

  // ─── list ───────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns links when caller is a workspace member', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue(
        workspaceWithMember('user-1'),
      );
      const links = [{ id: 'l1', url: 'https://figma.com', title: null }];
      mockPrismaService.sharedLink.findMany.mockResolvedValue(links);

      const result = await service.list('ws-1', 'user-1', UserRole.CLIENT);

      expect(result).toEqual(links);
      expect(mockPrismaService.sharedLink.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workspaceId: 'ws-1' },
          orderBy: { createdAt: 'desc' },
        }),
      );
    });

    it('throws ForbiddenException when caller is not a member', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue({
        ownerId: 'someone-else',
        members: [],
      });

      await expect(
        service.list('ws-1', 'user-1', UserRole.CLIENT),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrismaService.sharedLink.findMany).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when workspace does not exist', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue(null);

      await expect(
        service.list('missing', 'user-1', UserRole.CLIENT),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── create ─────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('persists the link with the caller as creator when member', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue(
        workspaceWithMember('user-1'),
      );
      mockPrismaService.sharedLink.create.mockResolvedValue({
        id: 'l1',
        url: 'https://figma.com/file/x',
        title: 'Mockup',
      });

      await service.create('ws-1', 'user-1', UserRole.CLIENT, {
        url: 'https://figma.com/file/x',
        title: 'Mockup',
      });

      expect(mockPrismaService.sharedLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            workspaceId: 'ws-1',
            addedById: 'user-1',
            url: 'https://figma.com/file/x',
            title: 'Mockup',
          },
        }),
      );
    });

    it('persists title as null when omitted', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue(
        workspaceWithMember('user-1'),
      );
      mockPrismaService.sharedLink.create.mockResolvedValue({ id: 'l1' });

      await service.create('ws-1', 'user-1', UserRole.CLIENT, {
        url: 'https://example.com',
      });

      expect(mockPrismaService.sharedLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ title: null }),
        }),
      );
    });

    it('throws ForbiddenException when caller is not a member', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue({
        ownerId: 'someone-else',
        members: [],
      });

      await expect(
        service.create('ws-1', 'user-1', UserRole.CLIENT, {
          url: 'https://example.com',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrismaService.sharedLink.create).not.toHaveBeenCalled();
    });
  });

  // ─── remove ─────────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('throws NotFoundException when the link does not exist', async () => {
      mockPrismaService.sharedLink.findUnique.mockResolvedValue(null);

      await expect(
        service.remove('missing', 'user-1', UserRole.CLIENT),
      ).rejects.toThrow(NotFoundException);
      expect(mockPrismaService.sharedLink.delete).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when caller is neither creator nor workspace owner', async () => {
      mockPrismaService.sharedLink.findUnique.mockResolvedValue({
        id: 'l1',
        addedById: 'someone-else',
        workspace: { ownerId: 'owner-1' },
      });

      await expect(
        service.remove('l1', 'user-1', UserRole.CLIENT),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrismaService.sharedLink.delete).not.toHaveBeenCalled();
    });

    it('deletes the link when caller is the creator', async () => {
      mockPrismaService.sharedLink.findUnique.mockResolvedValue({
        id: 'l1',
        addedById: 'user-1',
        workspace: { ownerId: 'owner-1' },
      });
      mockPrismaService.sharedLink.delete.mockResolvedValue({ id: 'l1' });

      const result = await service.remove('l1', 'user-1', UserRole.CLIENT);

      expect(mockPrismaService.sharedLink.delete).toHaveBeenCalledWith({
        where: { id: 'l1' },
      });
      expect(result).toEqual({ id: 'l1', deleted: true });
    });

    it('deletes the link when caller is the workspace owner', async () => {
      mockPrismaService.sharedLink.findUnique.mockResolvedValue({
        id: 'l1',
        addedById: 'someone-else',
        workspace: { ownerId: 'owner-1' },
      });
      mockPrismaService.sharedLink.delete.mockResolvedValue({ id: 'l1' });

      await service.remove('l1', 'owner-1', UserRole.FREELANCER);

      expect(mockPrismaService.sharedLink.delete).toHaveBeenCalled();
    });

    it('forbids a non-owner from deleting an orphaned link (addedById null must not match caller)', async () => {
      mockPrismaService.sharedLink.findUnique.mockResolvedValue({
        id: 'l1',
        addedById: null,
        workspace: { ownerId: 'owner-1' },
      });

      await expect(
        service.remove('l1', 'other-client', UserRole.CLIENT),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrismaService.sharedLink.delete).not.toHaveBeenCalled();
    });

    it('lets the workspace owner delete an orphaned link (addedById null)', async () => {
      mockPrismaService.sharedLink.findUnique.mockResolvedValue({
        id: 'l1',
        addedById: null,
        workspace: { ownerId: 'owner-1' },
      });
      mockPrismaService.sharedLink.delete.mockResolvedValue({ id: 'l1' });

      await service.remove('l1', 'owner-1', UserRole.FREELANCER);

      expect(mockPrismaService.sharedLink.delete).toHaveBeenCalled();
    });
  });
});
