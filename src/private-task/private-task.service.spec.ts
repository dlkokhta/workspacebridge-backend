/* eslint-disable
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/unbound-method
*/
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TaskStatus } from '@prisma/client';
import { PrivateTaskService } from './private-task.service';
import { PrismaService } from '../prisma/prisma.service';

const mockPrismaService = {
  workspace: {
    findUnique: jest.fn(),
  },
  privateTask: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
};

describe('PrivateTaskService', () => {
  let service: PrivateTaskService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrivateTaskService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<PrivateTaskService>(PrivateTaskService);
    jest.clearAllMocks();
  });

  describe('list', () => {
    it('returns private tasks scoped to caller + workspace when caller is workspace owner', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue({
        ownerId: 'owner-1',
      });
      const tasks = [{ id: 'pt1', title: 'Invoice client' }];
      mockPrismaService.privateTask.findMany.mockResolvedValue(tasks);

      const result = await service.list('ws-1', 'owner-1');

      expect(result).toEqual(tasks);
      expect(mockPrismaService.privateTask.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'owner-1', workspaceId: 'ws-1' },
        }),
      );
    });

    it('throws ForbiddenException when caller is not the workspace owner', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue({
        ownerId: 'someone-else',
      });

      await expect(service.list('ws-1', 'client-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockPrismaService.privateTask.findMany).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException for a workspace member who is not the owner', async () => {
      // A client is a workspace member but should NOT see private tasks.
      mockPrismaService.workspace.findUnique.mockResolvedValue({
        ownerId: 'freelancer-1',
      });

      await expect(service.list('ws-1', 'client-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws NotFoundException when workspace does not exist', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue(null);

      await expect(service.list('missing', 'owner-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    it('creates a private task owned by the caller when workspace owner', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue({
        ownerId: 'owner-1',
      });
      mockPrismaService.privateTask.create.mockResolvedValue({ id: 'pt1' });

      await service.create('ws-1', 'owner-1', { title: 'Backup files' });

      expect(mockPrismaService.privateTask.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            userId: 'owner-1',
            workspaceId: 'ws-1',
            title: 'Backup files',
          },
        }),
      );
    });

    it('throws ForbiddenException when caller is not workspace owner', async () => {
      mockPrismaService.workspace.findUnique.mockResolvedValue({
        ownerId: 'someone-else',
      });

      await expect(
        service.create('ws-1', 'client-1', { title: 'Anything' }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrismaService.privateTask.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('throws NotFoundException when task does not exist', async () => {
      mockPrismaService.privateTask.findUnique.mockResolvedValue(null);

      await expect(
        service.update('missing', 'owner-1', { status: TaskStatus.DONE }),
      ).rejects.toThrow(NotFoundException);
      expect(mockPrismaService.privateTask.update).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when caller does not own the task', async () => {
      mockPrismaService.privateTask.findUnique.mockResolvedValue({
        id: 'pt1',
        userId: 'someone-else',
      });

      await expect(
        service.update('pt1', 'owner-1', { status: TaskStatus.DONE }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrismaService.privateTask.update).not.toHaveBeenCalled();
    });

    it('updates only status when title is omitted', async () => {
      mockPrismaService.privateTask.findUnique.mockResolvedValue({
        id: 'pt1',
        userId: 'owner-1',
      });
      mockPrismaService.privateTask.update.mockResolvedValue({
        id: 'pt1',
        status: TaskStatus.DONE,
      });

      await service.update('pt1', 'owner-1', { status: TaskStatus.DONE });

      expect(mockPrismaService.privateTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'pt1' },
          data: { status: TaskStatus.DONE },
        }),
      );
    });

    it('updates only title when status is omitted', async () => {
      mockPrismaService.privateTask.findUnique.mockResolvedValue({
        id: 'pt1',
        userId: 'owner-1',
      });
      mockPrismaService.privateTask.update.mockResolvedValue({
        id: 'pt1',
        title: 'New title',
      });

      await service.update('pt1', 'owner-1', { title: 'New title' });

      expect(mockPrismaService.privateTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'pt1' },
          data: { title: 'New title' },
        }),
      );
    });
  });

  describe('remove', () => {
    it('throws NotFoundException when task does not exist', async () => {
      mockPrismaService.privateTask.findUnique.mockResolvedValue(null);

      await expect(service.remove('missing', 'owner-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrismaService.privateTask.delete).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when caller does not own the task', async () => {
      mockPrismaService.privateTask.findUnique.mockResolvedValue({
        id: 'pt1',
        userId: 'someone-else',
      });

      await expect(service.remove('pt1', 'owner-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockPrismaService.privateTask.delete).not.toHaveBeenCalled();
    });

    it('deletes the task when caller is the owner', async () => {
      mockPrismaService.privateTask.findUnique.mockResolvedValue({
        id: 'pt1',
        userId: 'owner-1',
      });
      mockPrismaService.privateTask.delete.mockResolvedValue({ id: 'pt1' });

      const result = await service.remove('pt1', 'owner-1');

      expect(mockPrismaService.privateTask.delete).toHaveBeenCalledWith({
        where: { id: 'pt1' },
      });
      expect(result).toEqual({ id: 'pt1', deleted: true });
    });
  });
});
