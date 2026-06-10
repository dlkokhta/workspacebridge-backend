import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';

/**
 * Checks passwords against the HaveIBeenPwned "Pwned Passwords" API using
 * k-anonymity: only the first 5 characters of the SHA-1 hash ever leave the
 * server, so the password itself (and even its full hash) is never sent.
 *
 * The check fails open — if HIBP is slow or unreachable it returns 0, so a
 * third-party outage never blocks a legitimate password change.
 */
@Injectable()
export class PasswordBreachService {
  private readonly logger = new Logger(PasswordBreachService.name);
  private readonly apiUrl = 'https://api.pwnedpasswords.com/range';
  private readonly timeoutMs = 3000;

  async getBreachCount(password: string): Promise<number> {
    const sha1 = createHash('sha1')
      .update(password)
      .digest('hex')
      .toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.apiUrl}/${prefix}`, {
        // Add-Padding returns a padded response to hide the real result size
        headers: { 'Add-Padding': 'true' },
        signal: controller.signal,
      });

      if (!res.ok) {
        this.logger.warn(`HIBP responded ${res.status}; skipping breach check`);
        return 0;
      }

      const body = await res.text();
      for (const line of body.split('\n')) {
        const [hashSuffix, count] = line.trim().split(':');
        if (hashSuffix === suffix) {
          return parseInt(count, 10) || 0;
        }
      }
      return 0;
    } catch (err) {
      this.logger.warn(
        `HIBP breach check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0; // fail open
    } finally {
      clearTimeout(timeout);
    }
  }

  async isBreached(password: string): Promise<boolean> {
    return (await this.getBreachCount(password)) > 0;
  }
}
