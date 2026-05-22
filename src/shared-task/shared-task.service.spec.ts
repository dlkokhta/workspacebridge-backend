/* eslint-disable
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/unbound-method
*/
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TaskStatus } from '@prisma/client';
import { SharedTaskService } from './shared-task.service';
import { SharedTaskGateway } from './shared-task.gateway';
import { PrismaService } from '../prisma/prisma.service';

const mockPrismaService = {
  workspace: {
    findUnique: jest.fn(),
  },
  sharedTask: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
};

const mockSharedTaskGateway = {
  emitTaskCreated: jest.fn(),
  emitTaskUpdated: jest.fn(),
  emitTaskDeleted: jest.fn(),
};

const workspaceWithMember = (userId: string, ownerId = 'owner-1') => ({
  ownerId,
  members: [{ id: 'member-1', userId }],
});

describe('SharedTaskService', () => {
  let service: SharedTaskService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SharedTaskService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: SharedTaskGateway, useValue: mockSharedTaskGateway },
      ],
    }).compile();

    service = module.get<SharedTaskService>(SharedTaskService);
    jest.clearAllMocks();
  });

  describe('list', () => {
    it('returns tasks when caller is a workspace member', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue(
        workspaceWithMember('user-1'),
      );
      const tasks = [
        { id: 't1', title: 'Send mockups', status: TaskStatus.TODO },
      ];
      mockPrismaService.sharedTask.findMany.mockResolvedValue(tasks);

      const result = await service.list('ws-1', 'user-1');

      expect(result).toEqual(tasks);
      expect(mockPrismaService.sharedTask.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workspaceId: 'ws-1' },
          orderBy: { createdAt: 'desc' },
        }),
      );
    });

    it('returns tasks when caller is the workspace owner (not in members)', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue({
        ownerId: 'user-1',
        members: [],
      });
      mockPrismaService.sharedTask.findMany.mockResolvedValue([]);

      await service.list('ws-1', 'user-1');

      expect(mockPrismaService.sharedTask.findMany).toHaveBeenCalled();
    });

    it('throws ForbiddenException when caller is not a member', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue({
        ownerId: 'someone-else',
        members: [],
      });

      await expect(service.list('ws-1', 'user-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockPrismaService.sharedTask.findMany).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when workspace does not exist', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue(null);

      await expect(service.list('missing', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    it('persists the task with the caller as creator when member', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue(
        workspaceWithMember('user-1'),
      );
      mockPrismaService.sharedTask.create.mockResolvedValue({
        id: 't1',
        title: 'Send mockups',
        status: TaskStatus.TODO,
      });

      await service.create('ws-1', 'user-1', { title: 'Send mockups' });

      expect(mockPrismaService.sharedTask.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            workspaceId: 'ws-1',
            createdById: 'user-1',
            title: 'Send mockups',
          },
        }),
      );
    });

    it('throws ForbiddenException when caller is not a member', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue({
        ownerId: 'someone-else',
        members: [],
      });

      await expect(
        service.create('ws-1', 'user-1', { title: 'Anything' }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrismaService.sharedTask.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('throws NotFoundException when task does not exist', async () => {
      mockPrismaService.sharedTask.findUnique.mockResolvedValue(null);

      await expect(
        service.update('missing', 'user-1', { status: TaskStatus.DONE }),
      ).rejects.toThrow(NotFoundException);
      expect(mockPrismaService.sharedTask.update).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when caller is not a workspace member', async () => {
      mockPrismaService.sharedTask.findUnique.mockResolvedValue({
        id: 't1',
        workspaceId: 'ws-1',
      });
      mockPrismaService.workspace.findUnique.mockResolvedValue({
        ownerId: 'someone-else',
        members: [],
      });

      await expect(
        service.update('t1', 'user-1', { status: TaskStatus.DONE }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrismaService.sharedTask.update).not.toHaveBeenCalled();
    });

    it('updates only status when title is omitted', async () => {
      mockPrismaService.sharedTask.findUnique.mockResolvedValue({
        id: 't1',
        workspaceId: 'ws-1',
      });
      mockPrismaService.workspace.findUnique.mockResolvedValue(
        workspaceWithMember('user-1'),
      );
      mockPrismaService.sharedTask.update.mockResolvedValue({
        id: 't1',
        status: TaskStatus.DONE,
      });

      await service.update('t1', 'user-1', { status: TaskStatus.DONE });

      expect(mockPrismaService.sharedTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 't1' },
          data: { status: TaskStatus.DONE },
        }),
      );
    });

    it('updates only title when status is omitted', async () => {
      mockPrismaService.sharedTask.findUnique.mockResolvedValue({
        id: 't1',
        workspaceId: 'ws-1',
      });
      mockPrismaService.workspace.findUnique.mockResolvedValue(
        workspaceWithMember('user-1'),
      );
      mockPrismaService.sharedTask.update.mockResolvedValue({
        id: 't1',
        title: 'New title',
      });

      await service.update('t1', 'user-1', { title: 'New title' });

      expect(mockPrismaService.sharedTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 't1' },
          data: { title: 'New title' },
        }),
      );
    });

    it('allows any workspace member to update (not only creator)', async () => {
      mockPrismaService.sharedTask.findUnique.mockResolvedValue({
        id: 't1',
        workspaceId: 'ws-1',
      });
      mockPrismaService.workspace.findUnique.mockResolvedValue(
        workspaceWithMember('other-member'),
      );
      mockPrismaService.sharedTask.update.mockResolvedValue({
        id: 't1',
        status: TaskStatus.DONE,
      });

      await service.update('t1', 'other-member', { status: TaskStatus.DONE });

      expect(mockPrismaService.sharedTask.update).toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('throws NotFoundException when task does not exist', async () => {
      mockPrismaService.sharedTask.findUnique.mockResolvedValue(null);

      await expect(service.remove('missing', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrismaService.sharedTask.delete).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when caller is neither creator nor workspace owner', async () => {
      mockPrismaService.sharedTask.findUnique.mockResolvedValue({
        id: 't1',
        createdById: 'someone-else',
        workspace: { ownerId: 'owner-1' },
      });

      await expect(service.remove('t1', 'user-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockPrismaService.sharedTask.delete).not.toHaveBeenCalled();
    });

    it('deletes the task when caller is the creator', async () => {
      mockPrismaService.sharedTask.findUnique.mockResolvedValue({
        id: 't1',
        createdById: 'user-1',
        workspace: { ownerId: 'owner-1' },
      });
      mockPrismaService.sharedTask.delete.mockResolvedValue({ id: 't1' });

      const result = await service.remove('t1', 'user-1');

      expect(mockPrismaService.sharedTask.delete).toHaveBeenCalledWith({
        where: { id: 't1' },
      });
      expect(result).toEqual({ id: 't1', deleted: true });
    });

    it('deletes the task when caller is the workspace owner', async () => {
      mockPrismaService.sharedTask.findUnique.mockResolvedValue({
        id: 't1',
        createdById: 'someone-else',
        workspace: { ownerId: 'owner-1' },
      });
      mockPrismaService.sharedTask.delete.mockResolvedValue({ id: 't1' });

      await service.remove('t1', 'owner-1');

      expect(mockPrismaService.sharedTask.delete).toHaveBeenCalled();
    });

    it('forbids a non-owner from deleting an orphaned task (createdById null must not match caller)', async () => {
      mockPrismaService.sharedTask.findUnique.mockResolvedValue({
        id: 't1',
        createdById: null,
        workspace: { ownerId: 'owner-1' },
      });

      await expect(service.remove('t1', 'other-client')).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockPrismaService.sharedTask.delete).not.toHaveBeenCalled();
    });

    it('lets the workspace owner delete an orphaned task (createdById null)', async () => {
      mockPrismaService.sharedTask.findUnique.mockResolvedValue({
        id: 't1',
        createdById: null,
        workspace: { ownerId: 'owner-1' },
      });
      mockPrismaService.sharedTask.delete.mockResolvedValue({ id: 't1' });

      await service.remove('t1', 'owner-1');

      expect(mockPrismaService.sharedTask.delete).toHaveBeenCalled();
    });
  });
});
