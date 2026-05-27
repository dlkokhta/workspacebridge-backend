import { Injectable, NotFoundException } from '@nestjs/common';
import { UserRole, UserStatus, WorkspaceStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { StorageService } from '../file/storage/storage.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly mailService: MailService,
    private readonly storageService: StorageService,
  ) {}

  public async getStats() {
    const now = new Date();

    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(now.getDate() - 29);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

    const [
      totalUsers,
      totalWorkspaces,
      activeWorkspaces,
      completedWorkspaces,
      archivedWorkspaces,
      usersThisWeek,
      usersThisMonth,
      recentUsers,
      recentWorkspaces,
    ] = await Promise.all([
      this.prismaService.user.count(),
      this.prismaService.workspace.count(),
      this.prismaService.workspace.count({ where: { status: 'ACTIVE' } }),
      this.prismaService.workspace.count({ where: { status: 'COMPLETED' } }),
      this.prismaService.workspace.count({ where: { status: 'ARCHIVED' } }),
      this.prismaService.user.count({ where: { createdAt: { gte: startOfWeek } } }),
      this.prismaService.user.count({ where: { createdAt: { gte: startOfMonth } } }),
      this.prismaService.user.groupBy({
        by: ['createdAt'],
        where: { createdAt: { gte: thirtyDaysAgo } },
        _count: true,
        orderBy: { createdAt: 'asc' },
      }),
      this.prismaService.workspace.groupBy({
        by: ['createdAt'],
        where: { createdAt: { gte: thirtyDaysAgo } },
        _count: true,
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const signupsByDay = this.aggregateByDay(recentUsers, thirtyDaysAgo, now);
    const workspacesByDay = this.aggregateByDay(recentWorkspaces, thirtyDaysAgo, now);

    return {
      totalUsers,
      totalWorkspaces,
      activeWorkspaces,
      completedWorkspaces,
      archivedWorkspaces,
      usersThisWeek,
      usersThisMonth,
      signupsByDay,
      workspacesByDay,
    };
  }

  private aggregateByDay(
    rows: { createdAt: Date; _count: number }[],
    from: Date,
    to: Date,
  ): { date: string; count: number }[] {
    const map = new Map<string, number>();

    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      map.set(d.toISOString().slice(0, 10), 0);
    }

    for (const row of rows) {
      const key = row.createdAt.toISOString().slice(0, 10);
      map.set(key, (map.get(key) ?? 0) + row._count);
    }

    return Array.from(map, ([date, count]) => ({ date, count }));
  }

  public async getUsers() {
    return this.prismaService.user.findMany({
      select: {
        id: true,
        email: true,
        firstname: true,
        lastname: true,
        role: true,
        status: true,
        method: true,
        isVerified: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  public async updateUserRole(id: string, role: UserRole) {
    const user = await this.prismaService.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    return this.prismaService.user.update({
      where: { id },
      data: { role },
      select: { id: true, email: true, role: true },
    });
  }

  public async deleteUser(id: string) {
    const user = await this.prismaService.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    await this.prismaService.user.delete({ where: { id } });
    return { message: 'User deleted successfully' };
  }

  public async updateUserStatus(id: string, status: UserStatus) {
    const user = await this.prismaService.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    return this.prismaService.user.update({
      where: { id },
      data: { status },
      select: { id: true, email: true, status: true },
    });
  }

  public async getUserDetail(id: string) {
    const user = await this.prismaService.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        firstname: true,
        lastname: true,
        role: true,
        status: true,
        method: true,
        isVerified: true,
        isTwoFactorEnabled: true,
        plan: true,
        createdAt: true,
        updatedAt: true,
        ownedWorkspaces: {
          select: {
            id: true,
            name: true,
            color: true,
            status: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        workspaceMemberships: {
          select: {
            id: true,
            role: true,
            createdAt: true,
            workspace: {
              select: {
                id: true,
                name: true,
                color: true,
                status: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
        Session: {
          select: {
            id: true,
            ip: true,
            userAgent: true,
            createdAt: true,
            expiresAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!user) throw new NotFoundException('User not found');

    const invitesSent = await this.prismaService.workspaceInvite.findMany({
      where: {
        workspace: { ownerId: id },
      },
      select: {
        id: true,
        email: true,
        createdAt: true,
        expiresAt: true,
        usedAt: true,
        workspace: {
          select: { id: true, name: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return { ...user, invitesSent };
  }

  public async adminResetPassword(id: string) {
    const user = await this.prismaService.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    await this.prismaService.token.deleteMany({
      where: { email: user.email, type: 'PASSWORD_RESET' },
    });

    const token = randomUUID();
    await this.prismaService.token.create({
      data: {
        email: user.email,
        token,
        type: 'PASSWORD_RESET',
        expiresIn: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    await this.mailService.sendPasswordResetEmail(user.email, token);

    return { message: 'Password reset email sent' };
  }

  public async forceVerifyUser(id: string) {
    const user = await this.prismaService.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    return this.prismaService.user.update({
      where: { id },
      data: { isVerified: true },
      select: { id: true, email: true, isVerified: true },
    });
  }

  public async getWorkspaces() {
    return this.prismaService.workspace.findMany({
      select: {
        id: true,
        name: true,
        description: true,
        color: true,
        status: true,
        createdAt: true,
        owner: {
          select: {
            id: true,
            email: true,
            firstname: true,
            lastname: true,
          },
        },
        _count: {
          select: { members: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  public async updateWorkspaceStatus(id: string, status: WorkspaceStatus) {
    const workspace = await this.prismaService.workspace.findUnique({ where: { id } });
    if (!workspace) throw new NotFoundException('Workspace not found');

    return this.prismaService.workspace.update({
      where: { id },
      data: { status },
      select: { id: true, name: true, status: true },
    });
  }

  public async deleteWorkspace(id: string) {
    const workspace = await this.prismaService.workspace.findUnique({ where: { id } });
    if (!workspace) throw new NotFoundException('Workspace not found');

    await this.prismaService.workspace.delete({ where: { id } });
    return { message: 'Workspace deleted successfully' };
  }

  public async getInvites() {
    return this.prismaService.workspaceInvite.findMany({
      select: {
        id: true,
        email: true,
        createdAt: true,
        expiresAt: true,
        usedAt: true,
        workspace: {
          select: {
            id: true,
            name: true,
            owner: {
              select: { id: true, email: true, firstname: true, lastname: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  public async deleteInvite(id: string) {
    const invite = await this.prismaService.workspaceInvite.findUnique({ where: { id } });
    if (!invite) throw new NotFoundException('Invite not found');

    await this.prismaService.workspaceInvite.delete({ where: { id } });
    return { message: 'Invite revoked successfully' };
  }

  public async getSessions() {
    return this.prismaService.session.findMany({
      select: {
        id: true,
        ip: true,
        userAgent: true,
        createdAt: true,
        expiresAt: true,
        user: {
          select: { id: true, email: true, firstname: true, lastname: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  public async deleteSession(id: string) {
    const session = await this.prismaService.session.findUnique({ where: { id } });
    if (!session) throw new NotFoundException('Session not found');

    await this.prismaService.session.delete({ where: { id } });
    return { message: 'Session revoked successfully' };
  }

  public async getFiles() {
    return this.prismaService.file.findMany({
      select: {
        id: true,
        name: true,
        mimeType: true,
        size: true,
        deletedAt: true,
        createdAt: true,
        workspace: {
          select: { id: true, name: true },
        },
        uploadedBy: {
          select: { id: true, email: true, firstname: true, lastname: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  public async getFileStats() {
    const [totalFiles, totalSize, perWorkspace] = await Promise.all([
      this.prismaService.file.count({ where: { deletedAt: null } }),
      this.prismaService.file.aggregate({
        where: { deletedAt: null },
        _sum: { size: true },
      }),
      this.prismaService.file.groupBy({
        by: ['workspaceId'],
        where: { deletedAt: null },
        _count: true,
        _sum: { size: true },
      }),
    ]);

    const workspaceIds = perWorkspace.map((r) => r.workspaceId);
    const workspaces = await this.prismaService.workspace.findMany({
      where: { id: { in: workspaceIds } },
      select: { id: true, name: true },
    });
    const nameMap = new Map(workspaces.map((w) => [w.id, w.name]));

    return {
      totalFiles,
      totalSize: totalSize._sum.size ?? 0,
      perWorkspace: perWorkspace.map((r) => ({
        workspaceId: r.workspaceId,
        workspaceName: nameMap.get(r.workspaceId) ?? 'Unknown',
        fileCount: r._count,
        totalSize: r._sum.size ?? 0,
      })),
    };
  }

  public async deleteFile(id: string) {
    const file = await this.prismaService.file.findUnique({
      where: { id },
      select: { id: true, storageKey: true },
    });
    if (!file) throw new NotFoundException('File not found');

    await this.storageService.delete(file.storageKey).catch(() => undefined);
    await this.prismaService.file.delete({ where: { id } });
    return { message: 'File deleted successfully' };
  }
}
