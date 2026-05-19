import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from './storage/storage.service';
import { TRASH_RETENTION_DAYS } from './file.constants';

const CLEANUP_LOCK_KEY = 'file_trash_cleanup';
const BATCH_SIZE = 100;

@Injectable()
export class FileCleanupService {
  private readonly logger = new Logger(FileCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async sweepExpiredTrash(): Promise<void> {
    // pg_try_advisory_lock returns false if another instance is already
    // running the sweep; we silently skip rather than queue.
    const [{ locked }] = await this.prisma.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtext(${CLEANUP_LOCK_KEY})) AS locked
    `;
    if (!locked) {
      this.logger.debug('Trash sweep skipped — lock held by another instance');
      return;
    }

    try {
      await this.processExpired();
    } finally {
      await this.prisma.$executeRaw`
        SELECT pg_advisory_unlock(hashtext(${CLEANUP_LOCK_KEY}))
      `;
    }
  }

  private async processExpired(): Promise<void> {
    const cutoff = new Date(
      Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    let purged = 0;
    let failed = 0;

    // Process in batches; each iteration re-queries so a long-running sweep
    // picks up rows that age past the cutoff mid-run.
    while (true) {
      const batch = await this.prisma.file.findMany({
        where: { deletedAt: { not: null, lt: cutoff } },
        select: { id: true, storageKey: true },
        take: BATCH_SIZE,
      });
      if (batch.length === 0) break;

      for (const file of batch) {
        try {
          await this.storage.delete(file.storageKey);
          await this.prisma.file.delete({ where: { id: file.id } });
          purged++;
        } catch (err) {
          failed++;
          this.logger.error(
            `Failed to purge file ${file.id} (${file.storageKey})`,
            err instanceof Error ? err.stack : String(err),
          );
        }
      }

      if (batch.length < BATCH_SIZE) break;
    }

    if (purged > 0 || failed > 0) {
      this.logger.log(`Trash sweep: purged=${purged} failed=${failed}`);
    }
  }
}
