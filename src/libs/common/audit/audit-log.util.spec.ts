import type { Logger } from '@nestjs/common';
import type { PrismaService } from '../../../prisma/prisma.service';
import { writeAuditLog } from './audit-log.util';

interface MockPrisma {
  auditLog: { create: jest.Mock };
}

const makePrisma = (createImpl?: () => Promise<unknown>): MockPrisma => ({
  auditLog: {
    create: jest.fn(createImpl ?? (() => Promise.resolve({}))),
  },
});

const makeLogger = () => ({ error: jest.fn() });

const asPrisma = (p: MockPrisma) => p as unknown as PrismaService;
const asLogger = (l: { error: jest.Mock }) => l as unknown as Logger;

describe('writeAuditLog', () => {
  it('lifts email/ip/userAgent into columns and keeps the rest in metadata', () => {
    const prisma = makePrisma();

    writeAuditLog(asPrisma(prisma), asLogger(makeLogger()), 'auth.login', 'u1', {
      email: 'a@b.com',
      ip: '1.2.3.4',
      userAgent: 'UA',
      device: 'Mac',
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: 'auth.login',
        actorId: 'u1',
        targetType: 'user',
        targetId: 'u1',
        email: 'a@b.com',
        ip: '1.2.3.4',
        userAgent: 'UA',
        metadata: { device: 'Mac' },
      },
    });
  });

  it('omits metadata when nothing remains after extraction', () => {
    const prisma = makePrisma();

    writeAuditLog(asPrisma(prisma), asLogger(makeLogger()), 'auth.register', 'u1', {
      email: 'a@b.com',
    });

    const { data } = prisma.auditLog.create.mock.calls[0][0];
    expect(data.email).toBe('a@b.com');
    expect(data.metadata).toBeUndefined();
  });

  it('honours targetType / targetId overrides', () => {
    const prisma = makePrisma();

    writeAuditLog(
      asPrisma(prisma),
      asLogger(makeLogger()),
      'auth.account_linked',
      'actor-1',
      {},
      { targetType: 'account', targetId: 'acc-9' },
    );

    const { data } = prisma.auditLog.create.mock.calls[0][0];
    expect(data.targetType).toBe('account');
    expect(data.targetId).toBe('acc-9');
  });

  it('ignores non-string context values', () => {
    const prisma = makePrisma();

    writeAuditLog(asPrisma(prisma), asLogger(makeLogger()), 'auth.login', 'u1', {
      ip: 123 as unknown as string,
    });

    expect(prisma.auditLog.create.mock.calls[0][0].data.ip).toBeUndefined();
  });

  it('swallows a write failure and logs it', async () => {
    const prisma = makePrisma(() => Promise.reject(new Error('db down')));
    const logger = makeLogger();

    writeAuditLog(asPrisma(prisma), asLogger(logger), 'auth.login', 'u1', {});
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.error).toHaveBeenCalled();
  });
});
