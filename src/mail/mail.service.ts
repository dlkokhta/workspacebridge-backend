import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

interface NotificationEmailParams {
  to: string;
  // Used as both the email subject and the header line.
  heading: string;
  // Short preview/description shown in the body (e.g. the message text).
  body: string;
  // App path the CTA button opens, e.g. "/workspace/<id>" or "/portal".
  path: string;
  ctaLabel?: string;
}

@Injectable()
export class MailService {
  private resend: Resend;

  constructor(private readonly configService: ConfigService) {
    this.resend = new Resend(this.configService.get<string>('RESEND_API_KEY'));
  }

  async sendVerificationEmail(email: string, token: string) {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL');
    const verifyUrl = `${frontendUrl}/auth/verify-email?token=${token}`;
    const from =
      this.configService.get<string>('RESEND_FROM_EMAIL') ??
      'noreply@example.com';

    await this.resend.emails.send({
      from,
      to: email,
      subject: 'Verify your email address',
      html: this.buildVerificationEmail(verifyUrl),
    });
  }

  private buildVerificationEmail(verifyUrl: string): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Verify your email</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0"
          style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background:#5a8a6b;padding:32px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;letter-spacing:0.5px;">
                Confirm your email address
              </h1>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;">
              <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">
                Thanks for signing up! Click the button below to verify your email address.
                This link expires in <strong>24 hours</strong>.
              </p>
              <div style="text-align:center;margin:32px 0;">
                <a href="${verifyUrl}"
                  style="background:#5a8a6b;color:#ffffff;text-decoration:none;
                         padding:14px 32px;border-radius:6px;font-size:15px;
                         font-weight:600;display:inline-block;">
                  Verify Email Address
                </a>
              </div>
              <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.6;">
                If you didn't create an account, you can safely ignore this email.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#f9fafb;padding:20px 40px;border-top:1px solid #e5e7eb;text-align:center;">
              <p style="margin:0;color:#9ca3af;font-size:12px;">
                If the button doesn't work, copy and paste this link into your browser:<br/>
                <a href="${verifyUrl}" style="color:#5a8a6b;word-break:break-all;">${verifyUrl}</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();
  }

  // Sent to the real owner when someone tries to register with their email.
  // The registration response itself stays identical to a fresh signup (no
  // user enumeration), so this email is the only signal — and it goes to the
  // owner, not the prober.
  async sendAccountExistsEmail(email: string) {
    const from =
      this.configService.get<string>('RESEND_FROM_EMAIL') ??
      'noreply@example.com';

    await this.resend.emails.send({
      from,
      to: email,
      subject: 'You already have an account',
      html: this.buildAccountExistsEmail(),
    });
  }

  private buildAccountExistsEmail(): string {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL') ?? '';
    const loginUrl = `${frontendUrl}/login`;
    const resetUrl = `${frontendUrl}/passwordRecovery`;
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>You already have an account</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0"
          style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background:#5a8a6b;padding:32px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;letter-spacing:0.5px;">
                You already have an account
              </h1>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;">
              <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">
                Someone — most likely you — just tried to sign up for WorkspaceBridge
                with this email address, but an account with it already exists.
              </p>
              <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">
                If that was you, simply sign in instead. Forgot your password?
                You can reset it from the login page.
              </p>
              <div style="text-align:center;margin:32px 0;">
                <a href="${loginUrl}"
                  style="background:#5a8a6b;color:#ffffff;text-decoration:none;
                         padding:14px 32px;border-radius:6px;font-size:15px;
                         font-weight:600;display:inline-block;">
                  Sign in
                </a>
              </div>
              <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.6;">
                If this wasn't you, no action is needed — your account is safe and
                nothing was changed. You may want to
                <a href="${resetUrl}" style="color:#5a8a6b;">reset your password</a>
                if you're concerned.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#f9fafb;padding:20px 40px;border-top:1px solid #e5e7eb;text-align:center;">
              <p style="margin:0;color:#9ca3af;font-size:12px;">
                You're receiving this because your email address was used on the
                WorkspaceBridge sign-up form.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();
  }

  async sendWorkspaceInviteEmail(email: string, token: string, workspaceName: string) {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL');
    const inviteUrl = `${frontendUrl}/invite/${token}`;
    const from =
      this.configService.get<string>('RESEND_FROM_EMAIL') ?? 'noreply@example.com';

    await this.resend.emails.send({
      from,
      to: email,
      subject: `You've been invited to ${workspaceName}`,
      html: this.buildInviteEmail(inviteUrl, workspaceName),
    });
  }

  private buildInviteEmail(inviteUrl: string, workspaceName: string): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>You're invited</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0"
          style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:#5a8a6b;padding:32px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;letter-spacing:0.5px;">
                You've been invited
              </h1>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 40px;">
              <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">
                You've been invited to collaborate on <strong>${workspaceName}</strong> via WorkspaceBridge.
                Click the button below to set up your account and get access.
                This link expires in <strong>7 days</strong>.
              </p>
              <div style="text-align:center;margin:32px 0;">
                <a href="${inviteUrl}"
                  style="background:#5a8a6b;color:#ffffff;text-decoration:none;
                         padding:14px 32px;border-radius:6px;font-size:15px;
                         font-weight:600;display:inline-block;">
                  Accept Invitation
                </a>
              </div>
              <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.6;">
                If you weren't expecting this invitation, you can safely ignore this email.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#f9fafb;padding:20px 40px;border-top:1px solid #e5e7eb;text-align:center;">
              <p style="margin:0;color:#9ca3af;font-size:12px;">
                If the button doesn't work, copy and paste this link into your browser:<br/>
                <a href="${inviteUrl}" style="color:#5a8a6b;word-break:break-all;">${inviteUrl}</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();
  }

  async sendPasswordResetEmail(email: string, token: string) {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL');
    const resetUrl = `${frontendUrl}/auth/reset-password?token=${token}`;
    const from =
      this.configService.get<string>('RESEND_FROM_EMAIL') ??
      'noreply@example.com';

    await this.resend.emails.send({
      from,
      to: email,
      subject: 'Reset your password',
      html: this.buildPasswordResetEmail(resetUrl),
    });
  }

  private buildPasswordResetEmail(resetUrl: string): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Reset your password</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0"
          style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:#5a8a6b;padding:32px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;letter-spacing:0.5px;">
                Reset your password
              </h1>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 40px;">
              <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">
                We received a request to reset your password. Click the button below to choose a new one.
                This link expires in <strong>1 hour</strong>.
              </p>
              <div style="text-align:center;margin:32px 0;">
                <a href="${resetUrl}"
                  style="background:#5a8a6b;color:#ffffff;text-decoration:none;
                         padding:14px 32px;border-radius:6px;font-size:15px;
                         font-weight:600;display:inline-block;">
                  Reset Password
                </a>
              </div>
              <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.6;">
                If you didn't request a password reset, you can safely ignore this email.
                Your password will not be changed.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#f9fafb;padding:20px 40px;border-top:1px solid #e5e7eb;text-align:center;">
              <p style="margin:0;color:#9ca3af;font-size:12px;">
                If the button doesn't work, copy and paste this link into your browser:<br/>
                <a href="${resetUrl}" style="color:#5a8a6b;word-break:break-all;">${resetUrl}</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();
  }

  async sendNotificationEmail({
    to,
    heading,
    body,
    path,
    ctaLabel,
  }: NotificationEmailParams) {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL');
    const from =
      this.configService.get<string>('RESEND_FROM_EMAIL') ??
      'noreply@example.com';
    const ctaUrl = `${frontendUrl}${path}`;

    await this.resend.emails.send({
      from,
      to,
      subject: heading,
      html: this.buildNotificationEmail(
        heading,
        body,
        ctaUrl,
        ctaLabel ?? 'Open WorkspaceBridge',
      ),
    });
  }

  // Escapes dynamic text before it goes into the HTML template. Notification
  // headings/bodies can contain user-controlled content (message previews,
  // workspace names), so they must not be interpolated raw.
  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private buildNotificationEmail(
    heading: string,
    body: string,
    ctaUrl: string,
    ctaLabel: string,
  ): string {
    const safeHeading = this.escapeHtml(heading);
    const safeBody = this.escapeHtml(body);

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${safeHeading}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0"
          style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:#5a8a6b;padding:32px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;letter-spacing:0.5px;">
                ${safeHeading}
              </h1>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 40px;">
              <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">
                ${safeBody}
              </p>
              <div style="text-align:center;margin:32px 0;">
                <a href="${ctaUrl}"
                  style="background:#5a8a6b;color:#ffffff;text-decoration:none;
                         padding:14px 32px;border-radius:6px;font-size:15px;
                         font-weight:600;display:inline-block;">
                  ${ctaLabel}
                </a>
              </div>
              <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.6;">
                You're receiving this because you have notifications enabled on WorkspaceBridge.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#f9fafb;padding:20px 40px;border-top:1px solid #e5e7eb;text-align:center;">
              <p style="margin:0;color:#9ca3af;font-size:12px;">
                If the button doesn't work, copy and paste this link into your browser:<br/>
                <a href="${ctaUrl}" style="color:#5a8a6b;word-break:break-all;">${ctaUrl}</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();
  }
}
