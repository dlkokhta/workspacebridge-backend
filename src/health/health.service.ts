import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class HealthService {
  constructor(private readonly prismaService: PrismaService) {}

  /**
   * Cheap database round-trip to prove the connection is alive. Uses the
   * Prisma API (the codebase reserves raw SQL for SearchModule): a PK-indexed
   * `LIMIT 1` read whose only job is to not throw. Never propagates the error —
   * a down DB is a `false`, which the controller turns into a 503.
   */
  public async checkDatabase(): Promise<boolean> {
    try {
      await this.prismaService.user.findFirst({ select: { id: true } });
      return true;
    } catch {
      return false;
    }
  }
}
