import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SharedTaskGateway } from './shared-task.gateway';
import { CreateSharedTaskDto } from './dto/create-shared-task.dto';
import { UpdateSharedTaskDto } from './dto/update-shared-task.dto';

const SHARED_TASK_SELECT = {
  id: true,
  title: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  createdBy: {
    select: { id: true, firstname: true, lastname: true, email: true },
  },
} as const;

@Injectable()
export class SharedTaskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: SharedTaskGateway,
  ) {}

  async list(workspaceId: string, userId: string) {
    await this.ensureWorkspaceAccess(workspaceId, userId);

    return this.prisma.sharedTask.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      select: SHARED_TASK_SELECT,
    });
  }

  async create(workspaceId: string, userId: string, dto: CreateSharedTaskDto) {
    await this.ensureWorkspaceAccess(workspaceId, userId);

    const task = await this.prisma.sharedTask.create({
      data: {
        workspaceId,
        createdById: userId,
        title: dto.title,
      },
      select: SHARED_TASK_SELECT,
    });

    this.gateway.emitTaskCreated(workspaceId, task);
    return task;
  }

  async update(taskId: string, userId: string, dto: UpdateSharedTaskDto) {
    const task = await this.prisma.sharedTask.findUnique({
      where: { id: taskId },
      select: { id: true, workspaceId: true },
    });
    if (!task) {
      throw new NotFoundException('Shared task not found');
    }
    await this.ensureWorkspaceAccess(task.workspaceId, userId);

    const updated = await this.prisma.sharedTask.update({
      where: { id: taskId },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.status !== undefined && { status: dto.status }),
      },
      select: SHARED_TASK_SELECT,
    });

    this.gateway.emitTaskUpdated(task.workspaceId, updated);
    return updated;
  }

  async remove(taskId: string, userId: string) {
    const task = await this.prisma.sharedTask.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        workspaceId: true,
        createdById: true,
        workspace: { select: { ownerId: true } },
      },
    });
    if (!task) {
      throw new NotFoundException('Shared task not found');
    }

    const isCreator = task.createdById === userId;
    const isWorkspaceOwner = task.workspace.ownerId === userId;
    if (!isCreator && !isWorkspaceOwner) {
      throw new ForbiddenException(
        'Only the creator or workspace owner can delete this task',
      );
    }

    await this.prisma.sharedTask.delete({ where: { id: taskId } });
    this.gateway.emitTaskDeleted(task.workspaceId, taskId);
    return { id: taskId, deleted: true };
  }

  private async ensureWorkspaceAccess(
    workspaceId: string,
    userId: string,
  ): Promise<{ ownerId: string }> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        ownerId: true,
        members: { where: { userId }, select: { id: true } },
      },
    });
    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }
    const isOwner = workspace.ownerId === userId;
    const isMember = workspace.members.length > 0;
    if (!isOwner && !isMember) {
      throw new ForbiddenException('Not a workspace member');
    }
    return { ownerId: workspace.ownerId };
  }
}
