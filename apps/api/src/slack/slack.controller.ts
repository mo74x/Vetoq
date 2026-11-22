import crypto from 'node:crypto';
import {
  BadRequestException,
  Controller,
  Headers,
  Inject,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Request } from 'express';
import { eq, sql } from 'drizzle-orm';
import {
  approvalRequests,
  approvalTokens,
  approvalVotes,
  auditLogs,
  projects,
  webhookDeliveries,
  type HitlDb,
} from '@hitl/db';
import { DB_TOKEN } from '../db/db.module.js';
import { CryptoService } from '../common/crypto.service.js';
import { QUEUE_TIMEOUTS, QUEUE_WEBHOOKS } from '../workers/queues.module.js';

interface SlackInteractionPayload {
  user?: { id?: string; username?: string; name?: string };
  actions?: Array<{ action_id?: string; value?: string }>;
}

@Controller('v1/slack')
export class SlackController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: HitlDb,
    private readonly crypto: CryptoService,
    @InjectQueue(QUEUE_TIMEOUTS) private readonly timeoutQueue: Queue,
    @InjectQueue(QUEUE_WEBHOOKS) private readonly webhookQueue: Queue,
  ) {}

  private verifySlackSignature(
    rawBody: Buffer,
    timestampHeader: string | undefined,
    signatureHeader: string | undefined,
    signingSecret: string,
  ) {
    const ts = Number(timestampHeader);
    if (!ts || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300 || !signatureHeader) {
      throw new UnauthorizedException('Invalid Slack timestamp or signature');
    }

    const baseString = `v0:${ts}:${rawBody.toString('utf8')}`;
    const expected = `v0=${crypto.createHmac('sha256', signingSecret).update(baseString).digest('hex')}`;
    const a = Buffer.from(signatureHeader, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid Slack signature');
    }
  }

  @Post('interactions')
  async handleInteraction(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-slack-request-timestamp') timestampHeader: string | undefined,
    @Headers('x-slack-signature') signatureHeader: string | undefined,
  ) {
    const rawPayload = req.body?.payload;
    if (typeof rawPayload !== 'string') {
      throw new BadRequestException('Missing Slack interaction payload');
    }

    const interaction = JSON.parse(rawPayload) as SlackInteractionPayload;
    const action = interaction.actions?.[0];
    const requestId = action?.value;
    const decision =
      action?.action_id === 'hitl_approve'
        ? 'approve'
        : action?.action_id === 'hitl_reject'
          ? 'reject'
          : null;

    if (!requestId || !decision) {
      throw new BadRequestException('Unsupported Slack action');
    }

    const [row] = await this.db
      .select({
        request: approvalRequests,
        project: projects,
      })
      .from(approvalRequests)
      .innerJoin(projects, eq(approvalRequests.projectId, projects.id))
      .where(eq(approvalRequests.id, requestId))
      .limit(1);

    if (!row) {
      throw new NotFoundException('Approval request not found');
    }
    if (!row.project.slackSigningSecretEnc) {
      throw new UnauthorizedException('Slack signing secret not configured for project');
    }

    const signingSecret = this.crypto.decryptSecret(row.project.slackSigningSecretEnc);
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
    this.verifySlackSignature(rawBody, timestampHeader, signatureHeader, signingSecret);

    const slackUser = interaction.user?.username ?? interaction.user?.name ?? interaction.user?.id ?? 'slack-user';
    const actorEmail = `${slackUser}@slack.local`;

    const deliveryId = await this.db.transaction(async (tx) => {
      const locked = await tx.execute(
        sql`SELECT * FROM approval_requests WHERE id = ${requestId} FOR UPDATE`,
      );
      const lockedRow = locked.rows[0] as Record<string, unknown> | undefined;
      if (!lockedRow || lockedRow.status !== 'pending') {
        return null;
      }

      const terminalStatus = decision === 'approve' ? 'approved' : 'rejected';
      await tx.insert(approvalVotes).values({
        approvalRequestId: requestId,
        approverEmail: actorEmail,
        approverName: slackUser,
        payloadVersion: Number(lockedRow.payload_version),
        decision,
      });

      await tx
        .update(approvalRequests)
        .set({
          status: terminalStatus,
          deliveryStatus: 'pending',
          decidedAt: new Date(),
        })
        .where(eq(approvalRequests.id, requestId));

      await tx
        .update(approvalTokens)
        .set({ usedAt: new Date() })
        .where(eq(approvalTokens.approvalRequestId, requestId));

      await tx.insert(auditLogs).values({
        projectId: String(lockedRow.project_id),
        approvalRequestId: requestId,
        eventType: terminalStatus,
        actorType: 'human',
        actorIdentifier: actorEmail,
        metadata: { source: 'slack' },
      });

      const [delivery] = await tx
        .insert(webhookDeliveries)
        .values({
          approvalRequestId: requestId,
          callbackUrl: String(lockedRow.callback_url),
          status: 'pending',
        })
        .returning();

      return delivery.id;
    });

    if (deliveryId) {
      await this.timeoutQueue.remove(`timeout_${requestId}`);
      await this.webhookQueue.add(
        'deliver-webhook',
        { deliveryId, approvalRequestId: requestId },
        { attempts: 5, backoff: { type: 'exponential', delay: 10000 }, removeOnComplete: true },
      );
    }

    return { text: `Recorded Slack ${decision} for request ${requestId}.` };
  }
}
