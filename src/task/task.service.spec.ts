/* eslint-disable
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/unbound-method
*/
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TaskStatus } from '@prisma/client';
import { TaskService } from './task.service';
import { PrismaService } from '../prisma/prisma.service';

const mockPrismaService = {
  workspace: {
    findUnique: jest.fn(),
  },
  task: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
};

const workspaceWithMember = (userId: string, ownerId = 'owner-1') => ({
  ownerId,
  members: [{ id: 'member-1', userId }],
});

describe('TaskService', () => {
  let service: TaskService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<TaskService>(TaskService);
    jest.clearAllMocks();
  });

  // ─── list ───────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns tasks when caller is a workspace member', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue(
        workspaceWithMember('user-1'),
      );
      const tasks = [
        { id: 't1', title: 'Send mockups', status: TaskStatus.TODO },
      ];
      mockPrismaService.task.findMany.mockResolvedValue(tasks);

      const result = await service.list('ws-1', 'user-1');

      expect(result).toEqual(tasks);
      expect(mockPrismaService.task.findMany).toHaveBeenCalledWith(
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
      mockPrismaService.task.findMany.mockResolvedValue([]);

      await service.list('ws-1', 'user-1');

      expect(mockPrismaService.task.findMany).toHaveBeenCalled();
    });

    it('throws ForbiddenException when caller is not a member', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue({
        ownerId: 'someone-else',
        members: [],
      });

      await expect(service.list('ws-1', 'user-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockPrismaService.task.findMany).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when workspace does not exist', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue(null);

      await expect(service.list('missing', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── create ─────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('persists the task with the caller as creator when member', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue(
        workspaceWithMember('user-1'),
      );
      mockPrismaService.task.create.mockResolvedValue({
        id: 't1',
        title: 'Send mockups',
        status: TaskStatus.TODO,
      });

      await service.create('ws-1', 'user-1', { title: 'Send mockups' });

      expect(mockPrismaService.task.create).toHaveBeenCalledWith(
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
      expect(mockPrismaService.task.create).not.toHaveBeenCalled();
    });
  });

  // ─── update ─────────────────────────────────────────────────────────────────

  describe('update', () => {
    it('throws NotFoundException when task does not exist', async () => {
      mockPrismaService.task.findUnique.mockResolvedValue(null);

      await expect(
        service.update('missing', 'user-1', { status: TaskStatus.DONE }),
      ).rejects.toThrow(NotFoundException);
      expect(mockPrismaService.task.update).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when caller is not a workspace member', async () => {
      mockPrismaService.task.findUnique.mockResolvedValue({
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
      expect(mockPrismaService.task.update).not.toHaveBeenCalled();
    });

    it('updates only status when title is omitted', async () => {
      mockPrismaService.task.findUnique.mockResolvedValue({
        id: 't1',
        workspaceId: 'ws-1',
      });
      mockPrismaService.workspace.findUnique.mockResolvedValue(
        workspaceWithMember('user-1'),
      );
      mockPrismaService.task.update.mockResolvedValue({
        id: 't1',
        status: TaskStatus.DONE,
      });

      await service.update('t1', 'user-1', { status: TaskStatus.DONE });

      expect(mockPrismaService.task.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 't1' },
          data: { status: TaskStatus.DONE },
        }),
      );
    });

    it('updates only title when status is omitted', async () => {
      mockPrismaService.task.findUnique.mockResolvedValue({
        id: 't1',
        workspaceId: 'ws-1',
      });
      mockPrismaService.workspace.findUnique.mockResolvedValue(
        workspaceWithMember('user-1'),
      );
      mockPrismaService.task.update.mockResolvedValue({
        id: 't1',
        title: 'New title',
      });

      await service.update('t1', 'user-1', { title: 'New title' });

      expect(mockPrismaService.task.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 't1' },
          data: { title: 'New title' },
        }),
      );
    });

    it('allows any workspace member to update (not only creator)', async () => {
      mockPrismaService.task.findUnique.mockResolvedValue({
        id: 't1',
        workspaceId: 'ws-1',
      });
      mockPrismaService.workspace.findUnique.mockResolvedValue(
        workspaceWithMember('other-member'),
      );
      mockPrismaService.task.update.mockResolvedValue({
        id: 't1',
        status: TaskStatus.DONE,
      });

      await service.update('t1', 'other-member', { status: TaskStatus.DONE });

      expect(mockPrismaService.task.update).toHaveBeenCalled();
    });
  });

  // ─── remove ─────────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('throws NotFoundException when task does not exist', async () => {
      mockPrismaService.task.findUnique.mockResolvedValue(null);

      await expect(service.remove('missing', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrismaService.task.delete).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when caller is neither creator nor workspace owner', async () => {
      mockPrismaService.task.findUnique.mockResolvedValue({
        id: 't1',
        createdById: 'someone-else',
        workspace: { ownerId: 'owner-1' },
      });

      await expect(service.remove('t1', 'user-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockPrismaService.task.delete).not.toHaveBeenCalled();
    });

    it('deletes the task when caller is the creator', async () => {
      mockPrismaService.task.findUnique.mockResolvedValue({
        id: 't1',
        createdById: 'user-1',
        workspace: { ownerId: 'owner-1' },
      });
      mockPrismaService.task.delete.mockResolvedValue({ id: 't1' });

      const result = await service.remove('t1', 'user-1');

      expect(mockPrismaService.task.delete).toHaveBeenCalledWith({
        where: { id: 't1' },
      });
      expect(result).toEqual({ id: 't1', deleted: true });
    });

    it('deletes the task when caller is the workspace owner', async () => {
      mockPrismaService.task.findUnique.mockResolvedValue({
        id: 't1',
        createdById: 'someone-else',
        workspace: { ownerId: 'owner-1' },
      });
      mockPrismaService.task.delete.mockResolvedValue({ id: 't1' });

      await service.remove('t1', 'owner-1');

      expect(mockPrismaService.task.delete).toHaveBeenCalled();
    });

    it('forbids a non-owner from deleting an orphaned task (createdById null must not match caller)', async () => {
      mockPrismaService.task.findUnique.mockResolvedValue({
        id: 't1',
        createdById: null,
        workspace: { ownerId: 'owner-1' },
      });

      await expect(service.remove('t1', 'other-client')).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockPrismaService.task.delete).not.toHaveBeenCalled();
    });

    it('lets the workspace owner delete an orphaned task (createdById null)', async () => {
      mockPrismaService.task.findUnique.mockResolvedValue({
        id: 't1',
        createdById: null,
        workspace: { ownerId: 'owner-1' },
      });
      mockPrismaService.task.delete.mockResolvedValue({ id: 't1' });

      await service.remove('t1', 'owner-1');

      expect(mockPrismaService.task.delete).toHaveBeenCalled();
    });
  });
});
