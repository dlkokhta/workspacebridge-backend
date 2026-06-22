import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import * as sharpNs from 'sharp';
import { PrismaService } from '../prisma/prisma.service';

// sharp is CommonJS (`module.exports = fn`) but its types declare `export
// default`. This project's tsconfig has esModuleInterop off, so a plain
// `import sharp from 'sharp'` compiles to `sharp_1.default`, which is
// `undefined` at runtime ("sharp_1.default is not a function") — every avatar
// upload failed. Binding the namespace (the function at runtime) and re-typing
// it to the chain we use keeps the call type-safe while emitting a direct
// `require('sharp')` call, independent of how sharp's dual ESM/CJS types resolve.
interface SharpChain {
  rotate(): SharpChain;
  resize(width: number, height: number, options: { fit: 'cover' }): SharpChain;
  webp(options: { quality: number }): SharpChain;
  toBuffer(): Promise<Buffer>;
}
const sharp = sharpNs as unknown as (input: Buffer) => SharpChain;

const AVATAR_SIZE = 512;

@Injectable()
export class AvatarService {
  constructor(private readonly prismaService: PrismaService) {}

  /**
   * Re-encodes an uploaded image to a square 512px WebP (EXIF stripped — sharp
   * drops metadata unless asked to keep it; `.rotate()` first bakes in the
   * orientation so the crop is upright), stores the bytes, and points the
   * user's `picture` at the public avatar URL with a content-hash cache-bust.
   */
  public async uploadAvatar(
    userId: string,
    file: Express.Multer.File | undefined,
    baseUrl: string,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('No image file was uploaded');
    }

    let webp: Buffer;
    try {
      webp = await sharp(file.buffer)
        .rotate()
        .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover' })
        .webp({ quality: 82 })
        .toBuffer();
    } catch {
      throw new BadRequestException('The uploaded file is not a valid image');
    }

    const hash = createHash('sha256').update(webp).digest('hex').slice(0, 16);

    await this.prismaService.$transaction([
      this.prismaService.userAvatar.upsert({
        where: { userId },
        create: { userId, data: webp, contentType: 'image/webp', hash },
        update: { data: webp, contentType: 'image/webp', hash },
      }),
      this.prismaService.user.update({
        where: { id: userId },
        data: { picture: `${baseUrl}/user/${userId}/avatar?v=${hash}` },
      }),
    ]);

    return { picture: `${baseUrl}/user/${userId}/avatar?v=${hash}` };
  }

  /** Removes the custom avatar and clears the user's picture. */
  public async removeAvatar(userId: string) {
    await this.prismaService.$transaction([
      this.prismaService.userAvatar.deleteMany({ where: { userId } }),
      this.prismaService.user.update({
        where: { id: userId },
        data: { picture: null },
      }),
    ]);
    return { picture: null };
  }

  /** Raw bytes for the public GET endpoint. 404 when the user has no avatar. */
  public async getAvatar(userId: string) {
    const avatar = await this.prismaService.userAvatar.findUnique({
      where: { userId },
      select: { data: true, contentType: true, hash: true },
    });
    if (!avatar) throw new NotFoundException('No avatar set');
    return avatar;
  }
}
