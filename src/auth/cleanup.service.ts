import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CleanupService.name);
  private static readonly INTERVAL_MS = 60 * 60 * 1000; // run every hour
  private intervalHandle?: NodeJS.Timeout;

  constructor(private readonly prismaService: PrismaService) {}

  onModuleInit() {
    void this.runCleanup();
    this.intervalHandle = setInterval(
      () => void this.runCleanup(),
      CleanupService.INTERVAL_MS,
    );
  }

  onModuleDestroy() {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  private async runCleanup() {
    try {
      const now = new Date();

      const expiredSessions = await this.prismaService.session.deleteMany({
        where: { expiresAt: { lt: now } },
      });

      const expiredTokens = await this.prismaService.token.deleteMany({
        where: { expiresIn: { lt: now } },
      });

      const expiredExchangeCodes =
        await this.prismaService.authExchangeCode.deleteMany({
          where: { expiresAt: { lt: now } },
        });

      const expiredTwoFactorAttempts =
        await this.prismaService.twoFactorAttempt.deleteMany({
          where: { expiresAt: { lt: now } },
        });

      const expiredPendingSetups =
        await this.prismaService.pendingTwoFactorSetup.deleteMany({
          where: { expiresAt: { lt: now } },
        });

      const total =
        expiredSessions.count +
        expiredTokens.count +
        expiredExchangeCodes.count +
        expiredTwoFactorAttempts.count +
        expiredPendingSetups.count;
      if (total > 0) {
        this.logger.log(
          `Cleanup removed ${expiredSessions.count} sessions, ` +
            `${expiredTokens.count} tokens, ` +
            `${expiredExchangeCodes.count} exchange codes, ` +
            `${expiredTwoFactorAttempts.count} 2FA attempts, ` +
            `${expiredPendingSetups.count} pending 2FA setups`,
        );
      }
    } catch (error) {
      this.logger.error('Cleanup job failed', error);
    }
  }
}
