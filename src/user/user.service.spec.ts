import { Test, TestingModule } from '@nestjs/testing';
import { UserService } from './user.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import * as argon2 from 'argon2';

jest.mock('argon2');

const mockedHash = argon2.hash as jest.MockedFunction<typeof argon2.hash>;
const mockedVerify = argon2.verify as jest.MockedFunction<typeof argon2.verify>;

const fakeUser = {
  id: 'user-123',
  firstname: 'John',
  lastname: 'Doe',
  email: 'john@example.com',
  password: 'hashed-password',
  role: 'USER',
  picture: null,
  method: 'LOCAL',
  isVerified: true,
  createdAt: new Date(),
};

const mockPrismaService = {
  user: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
};

describe('UserService', () => {
  let service: UserService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<UserService>(UserService);

    jest.clearAllMocks();
  });

  // ─── findByEmail ────────────────────────────────────────────────────────────

  describe('findByEmail', () => {
    it('returns a user when found', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(fakeUser);

      const result = await service.findByEmail('john@example.com');

      expect(mockPrismaService.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'john@example.com' },
      });
      expect(result).toEqual(fakeUser);
    });

    it('returns null when user does not exist', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      const result = await service.findByEmail('nobody@example.com');

      expect(result).toBeNull();
    });
  });

  // ─── findById ───────────────────────────────────────────────────────────────

  describe('findById', () => {
    it('returns a user when found', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(fakeUser);

      const result = await service.findById('user-123');

      expect(mockPrismaService.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-123' },
      });
      expect(result).toEqual(fakeUser);
    });

    it('returns null when user does not exist', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      const result = await service.findById('non-existent-id');

      expect(result).toBeNull();
    });
  });

  // ─── create ─────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('hashes the password and creates the user', async () => {
      mockedHash.mockResolvedValue('hashed-pw' as never);
      mockPrismaService.user.create.mockResolvedValue(fakeUser);

      const dto = {
        firstname: 'John',
        lastname: 'Doe',
        email: 'john@example.com',
        password: 'plaintext',
        passwordRepeat: 'plaintext',
      };

      const result = await service.create(dto);

      expect(mockedHash).toHaveBeenCalledWith('plaintext');
      expect(mockPrismaService.user.create).toHaveBeenCalledWith({
        data: {
          firstname: 'John',
          lastname: 'Doe',
          email: 'john@example.com',
          password: 'hashed-pw',
        },
      });
      expect(result).toEqual(fakeUser);
    });

    it('sets password to null when no password is provided (Google user)', async () => {
      mockPrismaService.user.create.mockResolvedValue({
        ...fakeUser,
        password: null,
        method: 'GOOGLE',
      });

      const dto = {
        firstname: 'Jane',
        lastname: 'Doe',
        email: 'jane@example.com',
        password: undefined,
        passwordRepeat: undefined,
      };

      await service.create(dto as any);

      expect(mockedHash).not.toHaveBeenCalled();

      expect(mockPrismaService.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ password: null }),
      });
    });
  });

  // ─── getProfile ─────────────────────────────────────────────────────────────

  describe('getProfile', () => {
    it('returns the user profile without password', async () => {
      const profileResult = {
        id: fakeUser.id,
        firstname: fakeUser.firstname,
        lastname: fakeUser.lastname,
        email: fakeUser.email,
        role: fakeUser.role,
        picture: fakeUser.picture,
        method: fakeUser.method,
        createdAt: fakeUser.createdAt,
      };
      mockPrismaService.user.findUnique.mockResolvedValue(profileResult);

      const result = await service.getProfile('user-123');

      expect(result).toEqual(profileResult);
      expect(result).not.toHaveProperty('password');
    });

    it('throws NotFoundException when user does not exist', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      await expect(service.getProfile('non-existent-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── updateProfile ──────────────────────────────────────────────────────────

  describe('updateProfile', () => {
    it('updates and returns the profile', async () => {
      const updatedProfile = { ...fakeUser, firstname: 'Jane' };
      mockPrismaService.user.update.mockResolvedValue(updatedProfile);

      const dto = { firstName: 'Jane', lastName: 'Doe' };
      const result = await service.updateProfile('user-123', dto);

      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { id: 'user-123' },
        data: { firstname: 'Jane', lastname: 'Doe' },
        select: expect.any(Object),
      });
      expect(result).toEqual(updatedProfile);
    });
  });

  // ─── changePassword ─────────────────────────────────────────────────────────

  describe('changePassword', () => {
    it('throws BadRequestException when user has no password (Google account)', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        ...fakeUser,
        password: null,
      });

      const dto = { currentPassword: 'old', newPassword: 'newPass123' };

      await expect(service.changePassword('user-123', dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when user is not found', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      const dto = { currentPassword: 'old', newPassword: 'newPass123' };

      await expect(service.changePassword('user-123', dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when current password is wrong', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(fakeUser);
      mockedVerify.mockResolvedValue(false);

      const dto = { currentPassword: 'wrong-password', newPassword: 'newPass123' };

      await expect(service.changePassword('user-123', dto)).rejects.toThrow(
        new BadRequestException('Current password is incorrect'),
      );
    });

    it('hashes and saves the new password on success', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(fakeUser);
      mockedVerify.mockResolvedValue(true);
      mockedHash.mockResolvedValue('new-hashed-pw' as never);

      const dto = { currentPassword: 'correct-password', newPassword: 'newPass123' };

      await service.changePassword('user-123', dto);

      expect(mockedHash).toHaveBeenCalledWith('newPass123');
      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { id: 'user-123' },
        data: { password: 'new-hashed-pw' },
      });
    });
  });
});
