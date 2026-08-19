import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { AppConfigService } from '../../config/app-config.service';

/**
 * Minimal SMTP mailer for transactional email (OTP codes, alerts).
 *
 * Dev: point EMAIL_HOST/EMAIL_PORT at the docker-compose MailHog instance
 * (localhost:1025) and every message is viewable at http://localhost:8025.
 * Prod: any SMTP relay (SES, Postmark, etc.) via the same env vars.
 *
 * When EMAIL_HOST is unset the service degrades to log-only so development
 * without the mail container never breaks the auth flows.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: nodemailer.Transporter | null = null;
  private readonly from: string;

  constructor(private readonly config: AppConfigService) {
    const email = this.config.email;
    this.from = email.from;

    if (email.host) {
      this.transporter = nodemailer.createTransport({
        host: email.host,
        port: email.port,
        secure: email.port === 465,
        auth: email.user
          ? { user: email.user, pass: email.password }
          : undefined,
      });
      this.logger.log(
        { host: email.host, port: email.port },
        'SMTP mail transport configured',
      );
    } else {
      this.logger.warn(
        'EMAIL_HOST not set — emails will be logged instead of sent',
      );
    }
  }

  // ── Branded email layout ────────────────────────────────────────────────────
  // Mobile-first, email-safe: a single centered column (no multi-column rows —
  // those collapse on narrow mail clients), tables + inline styles only, and
  // the real logo served from our own domain over HTTPS.

  private static readonly BRAND = {
    teal: '#164951',
    green: '#45B369',
    ink: '#1F2937',
    muted: '#6B7280',
    faint: '#9CA3AF',
    page: '#EDF2F0',
    panel: '#F6F8F7',
    border: '#E5E7EB',
    logoUrl: 'https://appine.online/assets/pine-logo.png',
    font: "-apple-system, 'Segoe UI', Roboto, Arial, Helvetica, sans-serif",
  };

  private fromAddress(): string {
    return this.from.replace(/^.*<|>$/g, '');
  }

  /**
   * Wrap body content in the branded shell: soft page background, white
   * rounded card with a dark-teal logo masthead and green accent rule, and a
   * stacked (never columnar) footer that survives every mobile mail client.
   */
  private renderShell(preheader: string, bodyHtml: string): string {
    const B = MailService.BRAND;
    return `<!doctype html>
<html>
<body style="margin:0; padding:0; background:${B.page};">
  <!-- Preheader: inbox preview text, invisible in the body -->
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">${preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${B.page}; padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:460px; background:#FFFFFF; border-radius:16px; overflow:hidden; border:1px solid ${B.border};">
        <!-- Masthead -->
        <tr>
          <td align="center" style="background:${B.teal}; padding:30px 24px 26px;">
            <img src="${B.logoUrl}" alt="Pine" width="52" style="display:block; width:52px; height:auto;" />
            <div style="font-family:${B.font}; font-size:24px; font-weight:800; color:#FFFFFF; letter-spacing:0.5px; margin-top:12px;">Pine</div>
            <div style="font-family:${B.font}; font-size:10px; font-weight:700; color:${B.green}; letter-spacing:3px; margin-top:3px;">MALAWI STOCK EXCHANGE</div>
          </td>
        </tr>
        <tr><td style="height:4px; background:${B.green}; font-size:0; line-height:0;">&nbsp;</td></tr>
        <!-- Body -->
        <tr>
          <td style="padding:34px 30px 30px;">
            ${bodyHtml}
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:0 30px;">
            <div style="border-top:1px solid ${B.border}; font-size:0; line-height:0;">&nbsp;</div>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:20px 30px 28px;">
            <div style="font-family:${B.font}; font-size:13px; font-weight:700; color:${B.teal};">The Pine Team</div>
            <div style="font-family:${B.font}; font-size:12px; color:${B.muted}; margin-top:3px;">Investing in the Malawi Stock Exchange</div>
            <div style="font-family:${B.font}; font-size:12px; color:${B.muted}; margin-top:10px;">Blantyre, Malawi</div>
            <div style="font-family:${B.font}; font-size:12px; margin-top:4px;">
              <a href="https://appine.online" style="color:${B.green}; text-decoration:none; font-weight:600;">appine.online</a>
              <span style="color:${B.faint};">&nbsp;&nbsp;·&nbsp;&nbsp;</span>
              <a href="mailto:${this.fromAddress()}" style="color:${B.green}; text-decoration:none; font-weight:600;">${this.fromAddress()}</a>
            </div>
          </td>
        </tr>
      </table>
      <div style="font-family:${B.font}; font-size:11px; color:${B.faint}; line-height:16px; max-width:460px; margin-top:16px; text-align:center;">
        This message is confidential and intended solely for the addressee.<br/>
        If you received it in error, please delete it and notify the sender.
      </div>
    </td></tr>
  </table>
</body>
</html>`;
  }

  /** Big rounded call-to-action button (bulletproof single-cell table). */
  private renderCta(label: string, url: string): string {
    const B = MailService.BRAND;
    return `
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:26px 0;">
        <tr><td align="center">
          <a href="${url}" style="display:block; background:${B.green}; color:#FFFFFF; font-family:${B.font}; font-size:16px; font-weight:700; text-decoration:none; text-align:center; padding:16px 20px; border-radius:12px;">${label}</a>
        </td></tr>
      </table>`;
  }

  private signatureText(): string {
    const email = this.fromAddress();
    return `\n\n—\nThe Pine Team\nInvesting in the Malawi Stock Exchange\nBlantyre, Malawi · https://appine.online · ${email}`;
  }

  /**
   * Send a verification code email. Never throws on delivery failure —
   * the OTP flow surfaces its own errors and the code stays retrievable
   * from dev logs; a mail outage must not 500 the auth endpoint.
   */
  async sendVerificationCode(to: string, code: string): Promise<boolean> {
    const subject = 'Your Pine verification code';
    const text =
      `Your Pine verification code is: ${code}\n\n` +
      `This code expires in 5 minutes. If you didn't request it, you can ignore this email.` +
      this.signatureText();
    const B = MailService.BRAND;
    const html = this.renderShell(
      `Your Pine verification code is ${code}`,
      `
      <div style="font-family:${B.font}; font-size:20px; font-weight:800; color:${B.ink};">Verify your email</div>
      <p style="font-family:${B.font}; font-size:15px; line-height:24px; color:${B.ink}; margin:14px 0 0;">
        Use this code to confirm your email address and continue setting up your Pine account:
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:24px 0;">
        <tr><td align="center" style="background:${B.panel}; border:1px solid ${B.border}; border-radius:12px; padding:22px;">
          <span style="font-family:'Courier New', Courier, monospace; font-size:34px; font-weight:800; letter-spacing:10px; color:${B.teal};">${code}</span>
        </td></tr>
      </table>
      <p style="font-family:${B.font}; font-size:13px; line-height:20px; color:${B.muted}; margin:0;">
        This code expires in <strong style="color:${B.ink};">5 minutes</strong>.
        If you didn't request it, you can safely ignore this email.
      </p>`,
    );

    if (!this.transporter) {
      this.logger.warn({ to, code }, '📧 DEV ONLY — email not sent (no SMTP host); code logged');
      return false;
    }

    try {
      await this.transporter.sendMail({ from: this.from, to, subject, text, html });
      this.logger.log({ to }, 'Verification email sent');
      return true;
    } catch (error) {
      this.logger.error({ err: error, to }, 'Failed to send verification email');
      return false;
    }
  }

  /**
   * Broker administrator onboarding invitation. Carries the one-time
   * activation token both as a prefilled link and as copyable text.
   * Never throws — invitation creation must not fail on a mail outage
   * (the token is still shown once in the Super Admin UI as a fallback).
   */
  async sendBrokerInvitation(params: {
    to: string;
    firstName: string;
    brokerName: string;
    activationUrl: string;
    token: string;
    expiresAt: Date;
  }): Promise<boolean> {
    const { to, firstName, brokerName, activationUrl, token, expiresAt } = params;
    const expiryText = expiresAt.toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric',
    });

    const subject = `You've been invited to manage ${brokerName} on Pine`;
    const text =
      `Hi ${firstName},\n\n` +
      `You've been invited to administer ${brokerName} on the Pine broker dashboard.\n\n` +
      `Activate your account and set your password here:\n${activationUrl}\n\n` +
      `If the link doesn't work, go to the activation page and paste this one-time invitation token:\n${token}\n\n` +
      `This invitation expires on ${expiryText}. After activating you'll be asked to set up two-factor authentication on first sign-in.\n\n` +
      `If you weren't expecting this invitation, you can ignore this email.` +
      this.signatureText();
    const B = MailService.BRAND;
    const html = this.renderShell(
      `Activate your ${brokerName} administrator account on Pine`,
      `
      <div style="font-family:${B.font}; font-size:20px; font-weight:800; color:${B.ink};">You're invited, ${firstName}</div>
      <p style="font-family:${B.font}; font-size:15px; line-height:24px; color:${B.ink}; margin:14px 0 0;">
        You've been invited to administer
        <strong style="color:${B.teal};">${brokerName}</strong>
        on the Pine broker dashboard — managing investors, orders, and KYC on the Malawi Stock Exchange.
      </p>
      ${this.renderCta('Activate your account', activationUrl)}
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px;">
        <tr><td style="background:${B.panel}; border:1px solid ${B.border}; border-radius:12px; padding:16px 18px;">
          <div style="font-family:${B.font}; font-size:10px; font-weight:700; letter-spacing:1.5px; color:${B.muted};">ONE-TIME INVITATION TOKEN</div>
          <div style="font-family:'Courier New', Courier, monospace; font-size:13px; color:${B.ink}; word-break:break-all; margin-top:8px; line-height:19px;">${token}</div>
          <div style="font-family:${B.font}; font-size:11px; color:${B.faint}; margin-top:8px;">Only needed if the button doesn't work — paste it on the activation page.</div>
        </td></tr>
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
        <tr>
          <td style="padding:0 0 8px;">
            <span style="font-family:${B.font}; font-size:13px; color:${B.muted};">⏳&nbsp; Invitation expires on <strong style="color:${B.ink};">${expiryText}</strong></span>
          </td>
        </tr>
        <tr>
          <td style="padding:0 0 8px;">
            <span style="font-family:${B.font}; font-size:13px; color:${B.muted};">🔑&nbsp; You'll choose your own password during activation</span>
          </td>
        </tr>
        <tr>
          <td>
            <span style="font-family:${B.font}; font-size:13px; color:${B.muted};">🛡&nbsp; Two-factor authentication is set up on first sign-in</span>
          </td>
        </tr>
      </table>
      <p style="font-family:${B.font}; font-size:12px; line-height:18px; color:${B.faint}; margin:22px 0 0;">
        If you weren't expecting this invitation, you can safely ignore this email.
      </p>`,
    );

    if (!this.transporter) {
      this.logger.warn({ to }, '📧 email not sent (no SMTP host) — invitation token available in the admin UI');
      return false;
    }

    try {
      await this.transporter.sendMail({ from: this.from, to, subject, text, html });
      this.logger.log({ to }, 'Broker invitation email sent');
      return true;
    } catch (error) {
      this.logger.error({ err: error, to }, 'Failed to send broker invitation email');
      return false;
    }
  }
}
