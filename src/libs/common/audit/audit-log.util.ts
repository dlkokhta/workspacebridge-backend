import type { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { AuditAction } from './audit-actions';

interface AuditOptions {
  targetType?: string;
  targetId?: string;
}

/**
 * Fire-and-forget audit writer shared by every service. Lifts the common
 * security context (`email`, `ip`, `userAgent`) out of the metadata object into
 * dedicated columns — so callers keep passing a single flat object and those
 * fields become queryable/indexable. Anything else stays in `metadata`. An
 * audit failure is logged server-side and dropped, never thrown.
 */
export function writeAuditLog(
  prisma: PrismaService,
  logger: Logger,
  action: AuditAction | string,
  actorId: string,
  metadata: Record<string, unknown> = {},
  options: AuditOptions = {},
): void {
  const { email, ip, userAgent, ...rest } = metadata;

  // JSON round-trip strips undefined values, which Prisma's JSON input rejects.
  const cleanMetadata =
    Object.keys(rest).length > 0
      ? (JSON.parse(JSON.stringify(rest)) as Prisma.InputJsonValue)
      : undefined;

  void Promise.resolve(
    prisma.auditLog.create({
      data: {
        action,
        actorId,
        targetType: options.targetType ?? 'user',
        targetId: options.targetId ?? actorId,
        email: typeof email === 'string' ? email : undefined,
        ip: typeof ip === 'string' ? ip : undefined,
        userAgent: typeof userAgent === 'string' ? userAgent : undefined,
        metadata: cleanMetadata,
      },
    }),
  ).catch((err) => logger.error('Failed to write audit log', err));
}
