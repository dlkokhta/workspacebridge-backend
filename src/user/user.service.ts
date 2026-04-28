import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateUserDto } from '../auth/dto/create-user.dto';
import { PrismaService } from '../prisma/prisma.service';
import { hash, verify } from 'argon2';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

@Injectable()
export class UserService {
  constructor(private readonly prismaService: PrismaService) {}

  public async findByEmail(email: string) {
    return this.prismaService.user.findUnique({
      where: { email },
    });
  }

  public async create(createUserDto: CreateUserDto) {
    const { passwordRepeat, password, ...rest } = createUserDto;
    const hashedPassword = password ? await hash(password) : null;
    return this.prismaService.user.create({
      data: { password: hashedPassword, ...rest },
    });
  }

  public async findById(id: string) {
    return this.prismaService.user.findUnique({
      where: { id },
    });
  }

  private readonly profileSelect = {
    id: true,
    firstname: true,
    lastname: true,
    email: true,
    role: true,
    picture: true,
    method: true,
    createdAt: true,
    isTwoFactorEnabled: true,
  } as const;

  public async getProfile(id: string) {
    const user = await this.prismaService.user.findUnique({
      where: { id },
      select: this.profileSelect,
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  public async updateProfile(id: string, dto: UpdateProfileDto) {
    return this.prismaService.user.update({
      where: { id },
      data: {
        firstname: dto.firstName,
        lastname: dto.lastName,
      },
      select: this.profileSelect,
    });
  }

  public async changePassword(id: string, dto: ChangePasswordDto) {
    const user = await this.prismaService.user.findUnique({ where: { id } });
    if (!user || !user.password) {
      throw new BadRequestException('Cannot change password for this account type');
    }
    const isValid = await verify(user.password, dto.currentPassword);
    if (!isValid) {
      throw new BadRequestException('Current password is incorrect');
    }
    const hashed = await hash(dto.newPassword);
    await this.prismaService.user.update({
      where: { id },
      data: { password: hashed },
    });
  }
}
