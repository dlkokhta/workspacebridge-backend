import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { AuditAction, LOGIN_ACTIONS } from '../libs/common/audit/audit-actions';
import { writeAuditLog } from '../libs/common/audit/audit-log.util';

/**
 * Sends a security alert email when an account is accessed from a device
 * (user-agent) we haven't seen succeed a login before. Helps users spot
 * unauthorized access early. Device history is read from the auth audit
 * trail, which survives session pruning/revocation.
 */
@Injectable()
export class LoginAlertService {
  private readonly logger = new Logger(LoginAlertService.name);

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
    action: AuditAction,
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

      // userAgent is a dedicated, indexed AuditLog column (see G5).
      const knownDevice = await this.prismaService.auditLog.findFirst({
        where: {
          actorId: userId,
          action: { in: LOGIN_ACTIONS },
          userAgent,
        },
      });
      if (knownDevice) return; // we've seen a login from this device before

      const anyPriorLogin = await this.prismaService.auditLog.findFirst({
        where: {
          actorId: userId,
          action: { in: LOGIN_ACTIONS },
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

  // Fire-and-forget audit write; email/ip/userAgent land in dedicated columns.
  private audit(
    action: AuditAction,
    userId: string,
    metadata: Record<string, unknown>,
  ): void {
    writeAuditLog(this.prismaService, this.logger, action, userId, metadata);
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
