import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SharedLinkGateway } from './shared-link.gateway';
import { CreateSharedLinkDto } from './dto/create-shared-link.dto';

@Injectable()
export class SharedLinkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: SharedLinkGateway,
  ) {}

  async list(workspaceId: string, userId: string, _userRole: UserRole) {
    await this.ensureWorkspaceAccess(workspaceId, userId);

    return this.prisma.sharedLink.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        url: true,
        title: true,
        createdAt: true,
        addedBy: {
          select: { id: true, firstname: true, lastname: true, email: true },
        },
      },
    });
  }

  async create(
    workspaceId: string,
    userId: string,
    _userRole: UserRole,
    dto: CreateSharedLinkDto,
  ) {
    await this.ensureWorkspaceAccess(workspaceId, userId);

    const link = await this.prisma.sharedLink.create({
      data: {
        workspaceId,
        addedById: userId,
        url: dto.url,
        title: dto.title ?? null,
      },
      select: {
        id: true,
        url: true,
        title: true,
        createdAt: true,
        addedBy: {
          select: { id: true, firstname: true, lastname: true, email: true },
        },
      },
    });

    this.gateway.emitLinkCreated(workspaceId, link);
    return link;
  }

  async remove(linkId: string, userId: string, _userRole: UserRole) {
    const link = await this.prisma.sharedLink.findUnique({
      where: { id: linkId },
      select: {
        id: true,
        workspaceId: true,
        addedById: true,
        workspace: { select: { ownerId: true } },
      },
    });
    if (!link) {
      throw new NotFoundException('Shared link not found');
    }

    const isCreator = link.addedById === userId;
    const isWorkspaceOwner = link.workspace.ownerId === userId;
    if (!isCreator && !isWorkspaceOwner) {
      throw new ForbiddenException(
        'Only the creator or workspace owner can delete this link',
      );
    }

    await this.prisma.sharedLink.delete({ where: { id: linkId } });
    this.gateway.emitLinkDeleted(link.workspaceId, linkId);
    return { id: linkId, deleted: true };
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
