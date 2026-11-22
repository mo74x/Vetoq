import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { Resend } from 'resend';
import { QUEUE_EMAILS } from './queues.module.js';

interface ReviewEmailJob {
  kind?: 'review' | 'otp';
  to: string;
  orgSlug?: string;
  orgName: string;
  token?: string;
  otpCode?: string;
  title: string;
  actionType?: string;
  summary?: string | null;
  isRenotification?: boolean;
}

@Processor(QUEUE_EMAILS)
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);
  private readonly resend: Resend | null;

  constructor() {
    super();
    const apiKey = process.env.RESEND_API_KEY;
    this.resend = apiKey && !apiKey.startsWith('re_test_') ? new Resend(apiKey) : null;
  }

  async process(job: Job<ReviewEmailJob>): Promise<void> {
    const { kind = 'review', to, orgSlug, orgName, token, otpCode, title, actionType, summary, isRenotification } =
      job.data;

    if (kind === 'otp') {
      const subject = `[${orgName}] Verification code for ${title}`;
      if (!this.resend) {
        this.logger.log(`[DEV OTP EMAIL] To=${to} Code=${otpCode}`);
        return;
      }
      await this.resend.emails.send({
        from: process.env.EMAIL_FROM ?? 'approvals@example.com',
        to,
        subject,
        html: `<p>Your 6-digit verification code for <strong>${title}</strong> is <strong>${otpCode}</strong>. It expires in 10 minutes.</p>`,
      });
      return;
    }

    const webUrl = (process.env.WEB_URL ?? 'http://localhost:3000').replace(/\/$/, '');
    const reviewUrl = `${webUrl}/p/${orgSlug}/review/${token}`;
    const subject = isRenotification
      ? `[${orgName}] Re-confirmation needed: ${title}`
      : `[${orgName}] Approval requested: ${title}`;

    if (!this.resend) {
      this.logger.log(`[DEV EMAIL] To=${to} Subject="${subject}" URL=${reviewUrl}`);
      return;
    }

    await this.resend.emails.send({
      from: process.env.EMAIL_FROM ?? 'approvals@example.com',
      to,
      subject,
      html: `
        <p><strong>${orgName}</strong> requires your review for action <code>${actionType}</code>.</p>
        <p><strong>${title}</strong></p>
        ${summary ? `<p>${summary}</p>` : ''}
        <p><a href="${reviewUrl}">Open Approval Review Portal</a></p>
      `,
    });
  }
}
