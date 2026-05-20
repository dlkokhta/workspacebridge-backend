import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';

const TASK_SELECT = {
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
export class TaskService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string, userId: string) {
    await this.ensureWorkspaceAccess(workspaceId, userId);

    return this.prisma.task.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      select: TASK_SELECT,
    });
  }

  async create(workspaceId: string, userId: string, dto: CreateTaskDto) {
    await this.ensureWorkspaceAccess(workspaceId, userId);

    return this.prisma.task.create({
      data: {
        workspaceId,
        createdById: userId,
        title: dto.title,
      },
      select: TASK_SELECT,
    });
  }

  async update(taskId: string, userId: string, dto: UpdateTaskDto) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, workspaceId: true },
    });
    if (!task) {
      throw new NotFoundException('Task not found');
    }
    await this.ensureWorkspaceAccess(task.workspaceId, userId);

    return this.prisma.task.update({
      where: { id: taskId },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.status !== undefined && { status: dto.status }),
      },
      select: TASK_SELECT,
    });
  }

  async remove(taskId: string, userId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        createdById: true,
        workspace: { select: { ownerId: true } },
      },
    });
    if (!task) {
      throw new NotFoundException('Task not found');
    }

    const isCreator = task.createdById === userId;
    const isWorkspaceOwner = task.workspace.ownerId === userId;
    if (!isCreator && !isWorkspaceOwner) {
      throw new ForbiddenException(
        'Only the creator or workspace owner can delete this task',
      );
    }

    await this.prisma.task.delete({ where: { id: taskId } });
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
