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

  // Sent to the NEW address when a user requests an email change. The account
  // email isn't switched until this link is confirmed.
  async sendEmailChangeVerification(newEmail: string, token: string) {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL');
    const confirmUrl = `${frontendUrl}/auth/confirm-email-change?token=${token}`;
    const from =
      this.configService.get<string>('RESEND_FROM_EMAIL') ??
      'noreply@example.com';

    await this.resend.emails.send({
      from,
      to: newEmail,
      subject: 'Confirm your new email address',
      html: this.buildEmailChangeVerification(confirmUrl),
    });
  }

  private buildEmailChangeVerification(confirmUrl: string): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Confirm your new email</title>
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
                Confirm your new email address
              </h1>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 40px;">
              <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">
                You asked to change the email address on your WorkspaceBridge account.
                Click the button below to confirm this is your address. This link
                expires in <strong>1 hour</strong>.
              </p>
              <div style="text-align:center;margin:32px 0;">
                <a href="${confirmUrl}"
                  style="background:#5a8a6b;color:#ffffff;text-decoration:none;
                         padding:14px 32px;border-radius:6px;font-size:15px;
                         font-weight:600;display:inline-block;">
                  Confirm New Email
                </a>
              </div>
              <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.6;">
                If you didn't request this change, you can safely ignore this email —
                your account email will stay the same.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#f9fafb;padding:20px 40px;border-top:1px solid #e5e7eb;text-align:center;">
              <p style="margin:0;color:#9ca3af;font-size:12px;">
                If the button doesn't work, copy and paste this link into your browser:<br/>
                <a href="${confirmUrl}" style="color:#5a8a6b;word-break:break-all;">${confirmUrl}</a>
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

  // Sent to the OLD address after an email change completes — the only mailbox
  // the original owner still controls, so a hijacked change can be spotted.
  async sendEmailChangedAlert(oldEmail: string, newEmail: string) {
    const from =
      this.configService.get<string>('RESEND_FROM_EMAIL') ??
      'noreply@example.com';

    await this.resend.emails.send({
      from,
      to: oldEmail,
      subject: 'Your email address was changed',
      html: this.buildEmailChangedAlert(oldEmail, newEmail),
    });
  }

  private buildEmailChangedAlert(oldEmail: string, newEmail: string): string {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL') ?? '';
    const resetUrl = `${frontendUrl}/passwordRecovery`;
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Your email address was changed</title>
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
                Your email address was changed
              </h1>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 40px;">
              <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">
                The email address on your WorkspaceBridge account was changed from
                <strong>${oldEmail}</strong> to <strong>${newEmail}</strong>.
              </p>
              <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.6;">
                If you made this change, no action is needed. If you didn't,
                <a href="${resetUrl}" style="color:#5a8a6b;">reset your password</a>
                immediately and contact support — someone may have access to your account.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#f9fafb;padding:20px 40px;border-top:1px solid #e5e7eb;text-align:center;">
              <p style="margin:0;color:#9ca3af;font-size:12px;">
                This is a security notification from WorkspaceBridge.
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

  // Security alert sent when a new way to sign in (Google link, or a password
  // on a previously OAuth-only account) is added — so the owner notices an
  // unauthorized addition.
  async sendSignInMethodAddedEmail(
    email: string,
    info: { method: string; date: Date },
  ) {
    const from =
      this.configService.get<string>('RESEND_FROM_EMAIL') ??
      'noreply@example.com';

    await this.resend.emails.send({
      from,
      to: email,
      subject: 'A new sign-in method was added to your account',
      html: this.buildSignInMethodAddedEmail(info),
    });
  }

  private buildSignInMethodAddedEmail(info: {
    method: string;
    date: Date;
  }): string {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL') ?? '';
    const resetUrl = `${frontendUrl}/passwordRecovery`;
    const when = info.date.toUTCString();
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>New sign-in method added</title>
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
                New sign-in method added
              </h1>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 40px;">
              <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">
                <strong>${info.method}</strong> was just added as a way to sign in to your
                WorkspaceBridge account on <strong>${when}</strong>.
              </p>
              <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.6;">
                If this was you, no action is needed. If you didn't do this,
                <a href="${resetUrl}" style="color:#5a8a6b;">reset your password</a>
                immediately and review your account security.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#f9fafb;padding:20px 40px;border-top:1px solid #e5e7eb;text-align:center;">
              <p style="margin:0;color:#9ca3af;font-size:12px;">
                This is a security notification from WorkspaceBridge.
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

  async sendNewDeviceAlertEmail(
    email: string,
    details: { device: string; ip: string; date: Date },
  ) {
    const from =
      this.configService.get<string>('RESEND_FROM_EMAIL') ??
      'noreply@example.com';

    await this.resend.emails.send({
      from,
      to: email,
      subject: 'New sign-in to your WorkspaceBridge account',
      html: this.buildNewDeviceAlertEmail(details),
    });
  }

  private buildNewDeviceAlertEmail(details: {
    device: string;
    ip: string;
    date: Date;
  }): string {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL') ?? '';
    const resetUrl = `${frontendUrl}/passwordRecovery`;
    // device/ip derive from request headers, so they are user-controlled.
    const device = this.escapeHtml(details.device);
    const ip = this.escapeHtml(details.ip);
    const date = details.date.toUTCString();
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>New sign-in detected</title>
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
                New sign-in detected
              </h1>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;">
              <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">
                Your WorkspaceBridge account was just signed in to from a device
                we haven't seen before:
              </p>
              <table cellpadding="0" cellspacing="0"
                style="margin:0 0 16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;width:100%;">
                <tr>
                  <td style="padding:16px 20px;color:#374151;font-size:14px;line-height:1.8;">
                    <strong>Device:</strong> ${device}<br/>
                    <strong>IP address:</strong> ${ip}<br/>
                    <strong>Time:</strong> ${date}
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">
                If this was you, no action is needed. If you don't recognize this
                sign-in, reset your password immediately — this will also sign
                out all devices.
              </p>
              <div style="text-align:center;margin:32px 0;">
                <a href="${resetUrl}"
                  style="background:#5a8a6b;color:#ffffff;text-decoration:none;
                         padding:14px 32px;border-radius:6px;font-size:15px;
                         font-weight:600;display:inline-block;">
                  Reset password
                </a>
              </div>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#f9fafb;padding:20px 40px;border-top:1px solid #e5e7eb;text-align:center;">
              <p style="margin:0;color:#9ca3af;font-size:12px;">
                You're receiving this security alert because of a sign-in to your
                WorkspaceBridge account.
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
