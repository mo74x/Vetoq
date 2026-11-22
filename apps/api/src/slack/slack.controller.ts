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
import { applyAndValidateEdits, type EditableSchemaMap } from '@hitl/shared';
import { DB_TOKEN } from '../db/db.module.js';
import { CryptoService } from '../common/crypto.service.js';
import { QUEUE_TIMEOUTS, QUEUE_WEBHOOKS } from '../workers/queues.module.js';
import { SlackService } from './slack.service.js';

interface SlackInteractionPayload {
  type?: 'block_actions' | 'view_submission';
  trigger_id?: string;
  user?: { id?: string; username?: string; name?: string };
  actions?: Array<{ action_id?: string; value?: string }>;
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: {
      values?: Record<string, Record<string, { value?: string }>>;
    };
  };
}

@Controller('v1/slack')
export class SlackController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: HitlDb,
    private readonly crypto: CryptoService,
    private readonly slackService: SlackService,
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
    const isModalSubmit =
      interaction.type === 'view_submission' &&
      interaction.view?.callback_id === 'hitl_edit_submit';
    const action = interaction.actions?.[0];
    const requestId = isModalSubmit
      ? interaction.view?.private_metadata
      : action?.value;

    if (!requestId) {
      throw new BadRequestException('Missing requestId in Slack interaction');
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

    // Handle "Edit & Approve" modal trigger
    if (!isModalSubmit && action?.action_id === 'hitl_open_edit') {
      if (!row.project.slackBotTokenEnc || !interaction.trigger_id || !row.request.editableSchema) {
        throw new BadRequestException('Slack bot token or editable_schema unavailable');
      }
      await this.slackService.openEditModal({
        botToken: this.crypto.decryptSecret(row.project.slackBotTokenEnc),
        triggerId: interaction.trigger_id,
        requestId,
        title: row.request.title,
        currentPayload: row.request.finalPayload ?? row.request.originalPayload,
        editableSchema: row.request.editableSchema as EditableSchemaMap,
      });
      return { ok: true };
    }

    const decision: 'approve' | 'reject' | null = isModalSubmit
      ? 'approve'
      : action?.action_id === 'hitl_approve'
        ? 'approve'
        : action?.action_id === 'hitl_reject'
          ? 'reject'
          : null;

    if (!decision) {
      throw new BadRequestException('Unsupported Slack action');
    }

    const slackUser =
      interaction.user?.username ?? interaction.user?.name ?? interaction.user?.id ?? 'slack-user';
    const actorEmail = `${slackUser}@slack.local`;

    // Parse edited values from Slack modal state if modal submission
    const editedFields: Record<string, unknown> = {};
    if (isModalSubmit && interaction.view?.state?.values && row.request.editableSchema) {
      const schema = row.request.editableSchema as EditableSchemaMap;
      for (const blockValues of Object.values(interaction.view.state.values)) {
        for (const [key, inputObj] of Object.entries(blockValues)) {
          const def = schema[key];
          if (!def || inputObj.value === undefined) continue;
          if (def.type === 'number') {
            editedFields[key] = Number(inputObj.value);
          } else if (def.type === 'boolean') {
            editedFields[key] = inputObj.value === 'true';
          } else {
            editedFields[key] = inputObj.value;
          }
        }
      }
    }

    const deliveryId = await this.db.transaction(async (tx) => {
      const locked = await tx.execute(
        sql`SELECT * FROM approval_requests WHERE id = ${requestId} FOR UPDATE`,
      );
      const lockedRow = locked.rows[0] as Record<string, unknown> | undefined;
      if (!lockedRow || lockedRow.status !== 'pending') {
        return null;
      }

      const currentPayload =
        (lockedRow.final_payload as Record<string, unknown> | null) ??
        (lockedRow.original_payload as Record<string, unknown>);
      let nextPayload = currentPayload;
      let diffPayload: unknown = null;
      let wasEdited = false;

      if (Object.keys(editedFields).length > 0) {
        const editRes = applyAndValidateEdits(
          currentPayload,
          editedFields,
          lockedRow.editable_schema as EditableSchemaMap | null,
        );
        if (!editRes.valid) {
          throw new BadRequestException({ message: 'Invalid Slack modal edits', errors: editRes.errors });
        }
        nextPayload = editRes.finalPayload;
        diffPayload = editRes.diff;
        wasEdited = editRes.changed;
      }

      const terminalStatus =
        decision === 'reject'
          ? 'rejected'
          : wasEdited
            ? 'edited_and_approved'
            : 'approved';

      await tx.insert(approvalVotes).values({
        approvalRequestId: requestId,
        approverEmail: actorEmail,
        approverName: slackUser,
        payloadVersion: Number(lockedRow.payload_version),
        decision,
        editedPayload: wasEdited ? nextPayload : null,
      });

      await tx
        .update(approvalRequests)
        .set({
          finalPayload: nextPayload,
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
        diffPayload,
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

    return isModalSubmit
      ? { response_action: 'clear' }
      : { text: `Recorded Slack ${decision} for request ${requestId}.` };
  }
}
