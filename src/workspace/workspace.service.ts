import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';

@Injectable()
export class WorkspaceService {
  constructor(private readonly prisma: PrismaService) {}

  async create(ownerId: string, dto: CreateWorkspaceDto) {
    return this.prisma.workspace.create({
      data: {
        name: dto.name,
        description: dto.description ?? null,
        color: dto.color ?? '#5a8a6b',
        ownerId,
      },
    });
  }

  async findAll(userId: string, role: UserRole) {
    if (role === UserRole.FREELANCER || role === UserRole.ADMIN) {
      return this.prisma.workspace.findMany({
        where: { ownerId: userId },
        orderBy: { createdAt: 'desc' },
      });
    }

    // CLIENT — workspaces they were invited to
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId },
      include: {
        workspace: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return memberships.map((m) => m.workspace);
  }

  async findOne(id: string, userId: string, role: UserRole) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id },
      include: {
        members: {
          include: { user: { select: { id: true, firstname: true, lastname: true, email: true, picture: true } } },
        },
      },
    });

    if (!workspace) throw new NotFoundException('Workspace not found');

    if (role === UserRole.FREELANCER || role === UserRole.ADMIN) {
      if (workspace.ownerId !== userId) throw new ForbiddenException('Access denied');
    } else {
      const isMember = workspace.members.some((m) => m.userId === userId);
      if (!isMember) throw new ForbiddenException('Access denied');
    }

    return workspace;
  }
}
