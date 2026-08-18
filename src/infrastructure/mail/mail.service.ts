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
      `If you weren't expecting this invitation, you can ignore this email.`;
    const html = `
      <div style="font-family: Arial, Helvetica, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #164951; margin-bottom: 4px;">Pine</h2>
        <p style="color: #374151; font-size: 15px;">Hi ${firstName},</p>
        <p style="color: #374151; font-size: 15px;">
          You've been invited to administer <strong>${brokerName}</strong> on the Pine broker dashboard.
        </p>
        <div style="text-align: center; margin: 24px 0;">
          <a href="${activationUrl}"
             style="background: #164951; color: #ffffff; text-decoration: none; padding: 13px 28px; border-radius: 10px; font-size: 15px; font-weight: bold; display: inline-block;">
            Activate your account
          </a>
        </div>
        <p style="color: #6B7280; font-size: 13px;">
          If the button doesn't work, open the activation page and paste this one-time invitation token:
        </p>
        <div style="background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 8px; padding: 12px; margin: 8px 0 16px; word-break: break-all;">
          <code style="font-size: 13px; color: #111827;">${token}</code>
        </div>
        <p style="color: #6B7280; font-size: 13px;">
          This invitation expires on <strong>${expiryText}</strong>. You'll set your own password during
          activation, and two-factor authentication is required on first sign-in.
        </p>
        <p style="color: #9CA3AF; font-size: 12px; margin-top: 20px;">
          If you weren't expecting this invitation, you can safely ignore this email.
        </p>
      </div>`;

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
