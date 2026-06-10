import { BadRequestException, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Enforces a password-history policy: a new password may not match the user's
 * current password or any of their last HISTORY_LIMIT previous passwords. Old
 * passwords are stored only as argon2 hashes, never in plaintext.
 */
@Injectable()
export class PasswordHistoryService {
  private static readonly HISTORY_LIMIT = 5;

  constructor(private readonly prismaService: PrismaService) {}

  /**
   * Throws BadRequestException if `newPassword` equals the current password
   * (`currentHash`, may be null for a first-time password) or any remembered
   * previous password.
   */
  async assertNotReused(
    userId: string,
    newPassword: string,
    currentHash: string | null,
  ): Promise<void> {
    if (currentHash && (await argon2.verify(currentHash, newPassword))) {
      throw new BadRequestException(
        "You can't reuse your current password. Please choose a new one.",
      );
    }

    const history = await this.prismaService.passwordHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: PasswordHistoryService.HISTORY_LIMIT,
    });

    for (const entry of history) {
      if (await argon2.verify(entry.password, newPassword)) {
        throw new BadRequestException(
          "You can't reuse a recent password. Please choose a different one.",
        );
      }
    }
  }

  /**
   * Records the just-replaced password hash and prunes the history back to the
   * most recent HISTORY_LIMIT entries. No-op when there is no previous hash
   * (e.g. an OAuth account setting its first password).
   */
  async record(userId: string, replacedHash: string | null): Promise<void> {
    if (!replacedHash) return;

    await this.prismaService.passwordHistory.create({
      data: { userId, password: replacedHash },
    });

    const entries = await this.prismaService.passwordHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    const stale = entries.slice(PasswordHistoryService.HISTORY_LIMIT);
    if (stale.length > 0) {
      await this.prismaService.passwordHistory.deleteMany({
        where: { id: { in: stale.map((e) => e.id) } },
      });
    }
  }
}
