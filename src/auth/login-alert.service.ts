import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';

/**
 * Sends a security alert email when an account is accessed from a device
 * (user-agent) we haven't seen succeed a login before. Helps users spot
 * unauthorized access early. Device history is read from the auth audit
 * trail, which survives session pruning/revocation.
 */
@Injectable()
export class LoginAlertService {
  private readonly logger = new Logger(LoginAlertService.name);

  // Success actions written by handleSuccessfulLogin — the device history
  // that notifyIfNewDevice fingerprints against.
  private static readonly LOGIN_ACTIONS = [
    'auth.login',
    'auth.google_login',
    'auth.2fa_login',
  ];

  constructor(
    private readonly prismaService: PrismaService,
    private readonly mailService: MailService,
  ) {}

  /**
   * Call once per completed login (password, OAuth exchange, or 2FA). Runs
   * the new-device check BEFORE recording this login, so the current login
   * isn't counted as a "prior" one, then writes the success audit row.
   * Never throws — an alert/audit failure must not break the login itself.
   */
  async handleSuccessfulLogin(
    action: string,
    params: { userId: string; email: string; ip?: string; userAgent?: string },
  ): Promise<void> {
    await this.notifyIfNewDevice(params);
    this.audit(action, params.userId, {
      email: params.email,
      ip: params.ip,
      userAgent: params.userAgent,
    });
  }

  async notifyIfNewDevice(params: {
    userId: string;
    email: string;
    ip?: string;
    userAgent?: string;
  }): Promise<void> {
    const { userId, email, ip, userAgent } = params;

    try {
      if (!userAgent) return; // can't fingerprint the device

      // ip/userAgent live in the audit metadata JSON until G5 adds
      // dedicated AuditLog columns.
      const knownDevice = await this.prismaService.auditLog.findFirst({
        where: {
          actorId: userId,
          action: { in: LoginAlertService.LOGIN_ACTIONS },
          metadata: { path: ['userAgent'], equals: userAgent },
        },
      });
      if (knownDevice) return; // we've seen a login from this device before

      const anyPriorLogin = await this.prismaService.auditLog.findFirst({
        where: {
          actorId: userId,
          action: { in: LoginAlertService.LOGIN_ACTIONS },
        },
      });
      if (!anyPriorLogin) return; // first ever login — expected, no alert

      // Send the email in the background so login latency isn't affected.
      void this.mailService
        .sendNewDeviceAlertEmail(email, {
          device: this.describeDevice(userAgent),
          ip: ip ?? 'unknown',
          date: new Date(),
        })
        .catch((err) =>
          this.logger.warn(
            `Failed to send new-device alert: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );

      this.audit('auth.new_device_login', userId, {
        email,
        ip,
        userAgent,
        device: this.describeDevice(userAgent),
      });
    } catch (err) {
      this.logger.warn(
        `New-device check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Fire-and-forget audit write, same contract as AuthService.auditAuthEvent:
  // an audit failure is logged server-side and dropped, never thrown.
  private audit(
    action: string,
    userId: string,
    metadata: Record<string, unknown>,
  ): void {
    // JSON round-trip strips undefined values, which Prisma's JSON input
    // rejects (ip/userAgent are optional).
    const cleanMetadata = JSON.parse(
      JSON.stringify(metadata),
    ) as Prisma.InputJsonValue;
    void Promise.resolve(
      this.prismaService.auditLog.create({
        data: {
          action,
          targetType: 'user',
          targetId: userId,
          actorId: userId,
          metadata: cleanMetadata,
        },
      }),
    ).catch((err) => this.logger.error('Failed to write auth audit log', err));
  }

  private describeDevice(ua: string): string {
    const browser = /edg/i.test(ua)
      ? 'Edge'
      : /opr|opera/i.test(ua)
        ? 'Opera'
        : /chrome|crios/i.test(ua)
          ? 'Chrome'
          : /firefox|fxios/i.test(ua)
            ? 'Firefox'
            : /safari/i.test(ua)
              ? 'Safari'
              : 'Unknown browser';

    const os = /windows/i.test(ua)
      ? 'Windows'
      : /android/i.test(ua)
        ? 'Android'
        : /iphone|ipad|ios/i.test(ua)
          ? 'iOS'
          : /mac os/i.test(ua)
            ? 'macOS'
            : /linux/i.test(ua)
              ? 'Linux'
              : 'Unknown OS';

    return `${browser} · ${os}`;
  }
}
