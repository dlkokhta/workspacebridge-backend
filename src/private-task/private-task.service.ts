import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePrivateTaskDto } from './dto/create-private-task.dto';
import { UpdatePrivateTaskDto } from './dto/update-private-task.dto';

const PRIVATE_TASK_SELECT = {
  id: true,
  title: true,
  status: true,
  workspaceId: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class PrivateTaskService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string, userId: string) {
    await this.ensureWorkspaceOwner(workspaceId, userId);

    return this.prisma.privateTask.findMany({
      where: { userId, workspaceId },
      orderBy: { createdAt: 'desc' },
      select: PRIVATE_TASK_SELECT,
    });
  }

  async create(
    workspaceId: string,
    userId: string,
    dto: CreatePrivateTaskDto,
  ) {
    await this.ensureWorkspaceOwner(workspaceId, userId);

    return this.prisma.privateTask.create({
      data: {
        userId,
        workspaceId,
        title: dto.title,
      },
      select: PRIVATE_TASK_SELECT,
    });
  }

  async update(taskId: string, userId: string, dto: UpdatePrivateTaskDto) {
    const task = await this.prisma.privateTask.findUnique({
      where: { id: taskId },
      select: { id: true, userId: true },
    });
    if (!task) {
      throw new NotFoundException('Private task not found');
    }
    if (task.userId !== userId) {
      throw new ForbiddenException('Not your task');
    }

    return this.prisma.privateTask.update({
      where: { id: taskId },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.status !== undefined && { status: dto.status }),
      },
      select: PRIVATE_TASK_SELECT,
    });
  }

  async remove(taskId: string, userId: string) {
    const task = await this.prisma.privateTask.findUnique({
      where: { id: taskId },
      select: { id: true, userId: true },
    });
    if (!task) {
      throw new NotFoundException('Private task not found');
    }
    if (task.userId !== userId) {
      throw new ForbiddenException('Not your task');
    }

    await this.prisma.privateTask.delete({ where: { id: taskId } });
    return { id: taskId, deleted: true };
  }

  // Only the workspace owner (freelancer) can access private tasks for a
  // given workspace. Even other members (clients) are blocked structurally.
  private async ensureWorkspaceOwner(
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { ownerId: true },
    });
    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }
    if (workspace.ownerId !== userId) {
      throw new ForbiddenException(
        'Only the workspace owner can access private tasks',
      );
    }
  }
}
