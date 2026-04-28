import { Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminService {
  constructor(private readonly prismaService: PrismaService) {}

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
}
