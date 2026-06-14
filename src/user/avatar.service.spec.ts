import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import sharp from 'sharp';
import { AvatarService } from './avatar.service';
import { PrismaService } from '../prisma/prisma.service';

jest.mock('sharp', () => ({ __esModule: true, default: jest.fn() }));

const mockedSharp = sharp as unknown as jest.Mock;

const mockPrismaService = {
  userAvatar: {
    upsert: jest.fn(),
    deleteMany: jest.fn(),
    findUnique: jest.fn(),
  },
  user: {
    update: jest.fn(),
  },
  $transaction: jest.fn().mockResolvedValue([]),
};

const WEBP = Buffer.from('processed-webp-bytes');
const EXPECTED_HASH = createHash('sha256')
  .update(WEBP)
  .digest('hex')
  .slice(0, 16);

const makeFile = (buffer: Buffer | undefined): Express.Multer.File =>
  ({ buffer, mimetype: 'image/png' }) as Express.Multer.File;

describe('AvatarService', () => {
  let service: AvatarService;
  let toBuffer: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrismaService.$transaction.mockResolvedValue([]);

    toBuffer = jest.fn().mockResolvedValue(WEBP);
    mockedSharp.mockReturnValue({
      rotate: jest.fn().mockReturnThis(),
      resize: jest.fn().mockReturnThis(),
      webp: jest.fn().mockReturnThis(),
      toBuffer,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AvatarService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<AvatarService>(AvatarService);
  });

  describe('uploadAvatar', () => {
    it('throws BadRequestException when no file is provided', async () => {
      await expect(
        service.uploadAvatar('user-1', undefined, 'http://x'),
      ).rejects.toThrow(BadRequestException);
      expect(mockedSharp).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when the buffer is empty', async () => {
      await expect(
        service.uploadAvatar('user-1', makeFile(Buffer.alloc(0)), 'http://x'),
      ).rejects.toThrow(BadRequestException);
    });

    it('re-encodes to webp, upserts, and points picture at the hashed URL', async () => {
      const result = await service.uploadAvatar(
        'user-1',
        makeFile(Buffer.from('raw-upload')),
        'http://localhost:4002',
      );

      const url = `http://localhost:4002/user/user-1/avatar?v=${EXPECTED_HASH}`;
      expect(result).toEqual({ picture: url });
      expect(mockPrismaService.userAvatar.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1' },
          create: expect.objectContaining({
            userId: 'user-1',
            data: WEBP,
            contentType: 'image/webp',
            hash: EXPECTED_HASH,
          }),
        }),
      );
      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { picture: url },
      });
      expect(mockPrismaService.$transaction).toHaveBeenCalledTimes(1);
    });

    it('throws BadRequestException when the image cannot be processed', async () => {
      toBuffer.mockRejectedValueOnce(new Error('not an image'));

      await expect(
        service.uploadAvatar('user-1', makeFile(Buffer.from('garbage')), 'http://x'),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrismaService.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('removeAvatar', () => {
    it('deletes the avatar and clears the picture', async () => {
      const result = await service.removeAvatar('user-1');

      expect(result).toEqual({ picture: null });
      expect(mockPrismaService.userAvatar.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { picture: null },
      });
    });
  });

  describe('getAvatar', () => {
    it('returns the stored avatar', async () => {
      const avatar = { data: WEBP, contentType: 'image/webp', hash: 'abc' };
      mockPrismaService.userAvatar.findUnique.mockResolvedValue(avatar);

      await expect(service.getAvatar('user-1')).resolves.toEqual(avatar);
    });

    it('throws NotFoundException when the user has no avatar', async () => {
      mockPrismaService.userAvatar.findUnique.mockResolvedValue(null);

      await expect(service.getAvatar('user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
