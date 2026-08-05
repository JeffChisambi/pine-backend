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

  /**
   * Send a verification code email. Never throws on delivery failure —
   * the OTP flow surfaces its own errors and the code stays retrievable
   * from dev logs; a mail outage must not 500 the auth endpoint.
   */
  async sendVerificationCode(to: string, code: string): Promise<boolean> {
    const subject = 'Your Pine verification code';
    const text =
      `Your Pine verification code is: ${code}\n\n` +
      `This code expires in 5 minutes. If you didn't request it, you can ignore this email.`;
    const html = `
      <div style="font-family: Arial, Helvetica, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #164951; margin-bottom: 4px;">Pine</h2>
        <p style="color: #374151; font-size: 15px;">Use this code to verify your email address:</p>
        <div style="background: #F0FDF4; border: 1px solid #86EFAC; border-radius: 10px; padding: 18px; text-align: center; margin: 16px 0;">
          <span style="font-size: 30px; font-weight: bold; letter-spacing: 8px; color: #164951;">${code}</span>
        </div>
        <p style="color: #6B7280; font-size: 13px;">This code expires in 5 minutes. If you didn't request it, you can safely ignore this email.</p>
      </div>`;

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
}
