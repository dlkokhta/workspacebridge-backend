import { Injectable, NotFoundException } from '@nestjs/common';
import { UserRole, WorkspaceStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminService {
  constructor(private readonly prismaService: PrismaService) {}

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
}
