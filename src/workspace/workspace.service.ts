import { Injectable } from '@nestjs/common';
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
}
