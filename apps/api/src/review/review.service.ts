import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  approvalRequests,
  approvalTokens,
  approvalVotes,
  auditLogs,
  organizations,
  policies,
  projects,
  webhookDeliveries,
  type HitlDb,
} from '@hitl/db';
import {
  MAX_EDIT_ROUNDS,
  applyAndValidateEdits,
  evaluatePolicies,
  type EditableSchemaMap,
  type PolicyRule,
  type SubmitDecisionRequest,
} from '@hitl/shared';
import { DB_TOKEN } from '../db/db.module.js';
import { CryptoService } from '../common/crypto.service.js';
import {
  QUEUE_EMAILS,
  QUEUE_TIMEOUTS,
  QUEUE_WEBHOOKS,
  REDIS_TOKEN,
} from '../workers/queues.module.js';

@Injectable()
export class ReviewService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: HitlDb,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
    private readonly crypto: CryptoService,
    @InjectQueue(QUEUE_TIMEOUTS) private readonly timeoutQueue: Queue,
    @InjectQueue(QUEUE_WEBHOOKS) private readonly webhookQueue: Queue,
    @InjectQueue(QUEUE_EMAILS) private readonly emailQueue: Queue,
  ) {}

  private async lookupValidToken(rawToken: string) {
    const tokenHash = this.crypto.sha256Hex(rawToken);
    const [row] = await this.db
      .select({
        token: approvalTokens,
        request: approvalRequests,
        orgName: organizations.name,
        orgSlug: organizations.slug,
        brandingConfig: organizations.brandingConfig,
      })
      .from(approvalTokens)
      .innerJoin(approvalRequests, eq(approvalTokens.approvalRequestId, approvalRequests.id))
      .innerJoin(projects, eq(approvalRequests.projectId, projects.id))
      .innerJoin(organizations, eq(projects.orgId, organizations.id))
      .where(eq(approvalTokens.tokenHash, tokenHash))
      .limit(1);

    if (!row) {
      throw new NotFoundException('Review link not found');
    }
    if (row.token.revokedAt || row.token.usedAt || row.token.expiresAt < new Date()) {
      throw new GoneException('Review link has expired or already been used');
    }
    return row;
  }

  /**
   * 100% read-only GET endpoint: performs zero DB writes.
   */
  async getReviewContext(rawToken: string) {
    const { token, request, orgName, orgSlug, brandingConfig } =
      await this.lookupValidToken(rawToken);

    const actionNonce = this.crypto.mintActionNonce(token.id, request.payloadVersion, 900);

    return {
      request_id: request.id,
      action_type: request.actionType,
      title: request.title,
      summary: request.summary,
      agent_name: request.agentName,
      status: request.status,
      payload_version: request.payloadVersion,
      edit_count: request.editCount,
      max_edit_rounds: MAX_EDIT_ROUNDS,
      required_approvals: request.requiredApprovals,
      original_payload: request.originalPayload,
      current_payload: request.finalPayload ?? request.originalPayload,
      editable_schema: request.editableSchema,
      expires_at: request.expiresAt.toISOString(),
      approver_email: token.approverEmail,
      action_nonce: actionNonce,
      organization: {
        name: orgName,
        slug: orgSlug,
        branding: brandingConfig,
      },
    };
  }

  async recordViewed(rawToken: string, metadata: { ip?: string; userAgent?: string }) {
    const { token, request } = await this.lookupValidToken(rawToken);
    await this.db.insert(auditLogs).values({
      projectId: request.projectId,
      approvalRequestId: request.id,
      eventType: 'viewed',
      actorType: 'human',
      actorIdentifier: token.approverEmail,
      metadata,
    });
    return { ok: true };
  }

  async submitDecision(rawToken: string, body: SubmitDecisionRequest) {
    const claims = this.crypto.verifyActionNonce(body.action_nonce);
    if (!claims) {
      throw new UnauthorizedException('Invalid or expired action_nonce');
    }

    const { token, orgName, orgSlug } = await this.lookupValidToken(rawToken);
    if (claims.token_id !== token.id) {
      throw new UnauthorizedException('action_nonce does not match review token');
    }

    // Enforce single-use action_nonce via Redis SET NX
    const consumed = await this.redis.set(`nonce:${claims.jti}`, '1', 'EX', 900, 'NX');
    if (consumed !== 'OK') {
      throw new ConflictException('action_nonce has already been used');
    }

    const result = await this.db.transaction(async (tx) => {
      const lockedResult = await tx.execute(
        sql`SELECT * FROM approval_requests WHERE id = ${token.approvalRequestId} FOR UPDATE`,
      );
      const lockedRow = lockedResult.rows[0] as Record<string, unknown> | undefined;
      if (!lockedRow) {
        throw new NotFoundException('Approval request not found');
      }

      if (lockedRow.status !== 'pending') {
        throw new ConflictException(`Approval request is already ${String(lockedRow.status)}`);
      }
      if (Number(lockedRow.payload_version) !== body.payload_version) {
        throw new ConflictException('Payload has been updated by another reviewer; reload required');
      }

      const currentPayload =
        (lockedRow.final_payload as Record<string, unknown> | null) ??
        (lockedRow.original_payload as Record<string, unknown>);
      const originalPayload = lockedRow.original_payload as Record<string, unknown>;
      const editableSchema = lockedRow.editable_schema as EditableSchemaMap | null;
      const projectId = String(lockedRow.project_id);
      let requiredApprovals = Number(lockedRow.required_approvals);
      let payloadVersion = Number(lockedRow.payload_version);
      let editCount = Number(lockedRow.edit_count);
      let effectivePolicySnapshot: Record<string, unknown> | null =
        (lockedRow.effective_policy_snapshot as Record<string, unknown> | null) ?? null;

      let payloadChanged = false;
      let nextPayload: Record<string, unknown> = currentPayload;
      let diffPayload: unknown = null;

      if (body.edited_fields && Object.keys(body.edited_fields).length > 0) {
        if (editCount >= MAX_EDIT_ROUNDS) {
          throw new BadRequestException(`Maximum of ${MAX_EDIT_ROUNDS} edit rounds reached`);
        }

        const editResult = applyAndValidateEdits(currentPayload, body.edited_fields, editableSchema);
        if (!editResult.valid) {
          throw new BadRequestException({
            message: 'Invalid payload edits',
            errors: editResult.errors,
          });
        }

        if (editResult.changed) {
          payloadChanged = true;
          nextPayload = editResult.finalPayload;
          diffPayload = editResult.diff;
          payloadVersion += 1;
          editCount += 1;

          // Re-evaluate policies on edited payload
          const dbPolicies = await tx
            .select()
            .from(policies)
            .where(and(eq(policies.projectId, projectId), eq(policies.isActive, true)));
          const policyRules: PolicyRule[] = dbPolicies.map((p) => ({
            id: p.id,
            action_type: p.actionType,
            priority: p.priority,
            conditions: (p.conditions as PolicyRule['conditions']) ?? [],
            decision_mode: p.decisionMode as PolicyRule['decision_mode'],
            required_approvals: p.requiredApprovals,
            timeout_seconds: p.timeoutSeconds,
            timeout_behavior: 'reject',
            approver_emails: p.approverEmails,
            is_active: p.isActive,
          }));

          const reEval = evaluatePolicies(String(lockedRow.action_type), nextPayload, policyRules);
          if (reEval.decision_mode === 'auto_reject') {
            await tx
              .update(approvalRequests)
              .set({
                finalPayload: nextPayload,
                payloadVersion,
                editCount,
                status: 'rejected',
                deliveryStatus: 'pending',
                decidedAt: new Date(),
              })
              .where(eq(approvalRequests.id, token.approvalRequestId));

            await tx
              .update(approvalTokens)
              .set({ usedAt: new Date() })
              .where(eq(approvalTokens.approvalRequestId, token.approvalRequestId));

            await tx.insert(auditLogs).values({
              projectId,
              approvalRequestId: token.approvalRequestId,
              eventType: 'rejected',
              actorType: 'system',
              actorIdentifier: 'policy-engine',
              diffPayload,
              metadata: { reason: 'edited_payload_matched_auto_reject' },
            });

            const [delivery] = await tx
              .insert(webhookDeliveries)
              .values({
                approvalRequestId: token.approvalRequestId,
                callbackUrl: String(lockedRow.callback_url),
                status: 'pending',
              })
              .returning();

            return {
              terminal: true,
              status: 'rejected' as const,
              deliveryId: delivery.id,
              renotifyEmails: [] as string[],
              payloadVersion,
            };
          }

          if (reEval.required_approvals > requiredApprovals) {
            requiredApprovals = reEval.required_approvals;
            effectivePolicySnapshot = reEval.matched_policy_snapshot as Record<
              string,
              unknown
            > | null;
          }

          // Supersede prior active votes on edit
          await tx
            .update(approvalVotes)
            .set({ supersededAt: new Date() })
            .where(
              and(
                eq(approvalVotes.approvalRequestId, token.approvalRequestId),
                isNull(approvalVotes.supersededAt),
              ),
            );

          await tx.insert(auditLogs).values([
            {
              projectId,
              approvalRequestId: token.approvalRequestId,
              eventType: 'edited',
              actorType: 'human',
              actorIdentifier: token.approverEmail,
              diffPayload,
              metadata: { payload_version: payloadVersion },
            },
            {
              projectId,
              approvalRequestId: token.approvalRequestId,
              eventType: 'votes_superseded',
              actorType: 'system',
              actorIdentifier: 'consensus-engine',
              metadata: { new_payload_version: payloadVersion },
            },
          ]);
        }
      }

      const approverName = body.approver_name ?? token.approverEmail;

      await tx.insert(approvalVotes).values({
        approvalRequestId: token.approvalRequestId,
        approverEmail: token.approverEmail,
        approverName,
        payloadVersion,
        decision: body.decision,
        editedPayload: payloadChanged ? nextPayload : null,
        note: body.note ?? null,
      });

      await tx.insert(auditLogs).values({
        projectId,
        approvalRequestId: token.approvalRequestId,
        eventType: 'vote_recorded',
        actorType: 'human',
        actorIdentifier: token.approverEmail,
        metadata: { decision: body.decision, payload_version: payloadVersion },
      });

      if (body.decision === 'reject') {
        await tx
          .update(approvalRequests)
          .set({
            finalPayload: nextPayload,
            payloadVersion,
            editCount,
            requiredApprovals,
            effectivePolicySnapshot,
            status: 'rejected',
            deliveryStatus: 'pending',
            decidedAt: new Date(),
          })
          .where(eq(approvalRequests.id, token.approvalRequestId));

        await tx
          .update(approvalTokens)
          .set({ usedAt: new Date() })
          .where(eq(approvalTokens.approvalRequestId, token.approvalRequestId));

        await tx.insert(auditLogs).values({
          projectId,
          approvalRequestId: token.approvalRequestId,
          eventType: 'rejected',
          actorType: 'human',
          actorIdentifier: token.approverEmail,
          metadata: { note: body.note ?? null },
        });

        const [delivery] = await tx
          .insert(webhookDeliveries)
          .values({
            approvalRequestId: token.approvalRequestId,
            callbackUrl: String(lockedRow.callback_url),
            status: 'pending',
          })
          .returning();

        return {
          terminal: true,
          status: 'rejected' as const,
          deliveryId: delivery.id,
          renotifyEmails: [] as string[],
          payloadVersion,
        };
      }

      // Count active approve votes on current payloadVersion
      const activeApproveVotes = await tx
        .select()
        .from(approvalVotes)
        .where(
          and(
            eq(approvalVotes.approvalRequestId, token.approvalRequestId),
            eq(approvalVotes.payloadVersion, payloadVersion),
            eq(approvalVotes.decision, 'approve'),
            isNull(approvalVotes.supersededAt),
          ),
        );

      if (activeApproveVotes.length >= requiredApprovals) {
        const wasEditedFromOriginal =
          JSON.stringify(originalPayload) !== JSON.stringify(nextPayload);
        const terminalStatus = wasEditedFromOriginal ? 'edited_and_approved' : 'approved';

        await tx
          .update(approvalRequests)
          .set({
            finalPayload: nextPayload,
            payloadVersion,
            editCount,
            requiredApprovals,
            effectivePolicySnapshot,
            status: terminalStatus,
            deliveryStatus: 'pending',
            decidedAt: new Date(),
          })
          .where(eq(approvalRequests.id, token.approvalRequestId));

        await tx
          .update(approvalTokens)
          .set({ usedAt: new Date() })
          .where(eq(approvalTokens.approvalRequestId, token.approvalRequestId));

        await tx.insert(auditLogs).values({
          projectId,
          approvalRequestId: token.approvalRequestId,
          eventType: 'approved',
          actorType: 'human',
          actorIdentifier: token.approverEmail,
          metadata: { status: terminalStatus, votes: activeApproveVotes.length },
        });

        const [delivery] = await tx
          .insert(webhookDeliveries)
          .values({
            approvalRequestId: token.approvalRequestId,
            callbackUrl: String(lockedRow.callback_url),
            status: 'pending',
          })
          .returning();

        return {
          terminal: true,
          status: terminalStatus,
          deliveryId: delivery.id,
          renotifyEmails: [] as string[],
          payloadVersion,
        };
      }

      // Still pending more approvals
      await tx
        .update(approvalRequests)
        .set({
          finalPayload: nextPayload,
          payloadVersion,
          editCount,
          requiredApprovals,
          effectivePolicySnapshot,
        })
        .where(eq(approvalRequests.id, token.approvalRequestId));

      const allTokens = payloadChanged
        ? await tx
            .select({ approverEmail: approvalTokens.approverEmail })
            .from(approvalTokens)
            .where(eq(approvalTokens.approvalRequestId, token.approvalRequestId))
        : [];

      return {
        terminal: false,
        status: 'pending' as const,
        deliveryId: null,
        renotifyEmails: allTokens
          .map((t) => t.approverEmail)
          .filter((e) => e !== token.approverEmail),
        payloadVersion,
      };
    });

    if (result.terminal && result.deliveryId) {
      await this.timeoutQueue.remove(`timeout_${token.approvalRequestId}`);
      await this.webhookQueue.add(
        'deliver-webhook',
        { deliveryId: result.deliveryId, approvalRequestId: token.approvalRequestId },
        { attempts: 5, backoff: { type: 'exponential', delay: 10000 }, removeOnComplete: true },
      );
    } else if (result.renotifyEmails.length > 0) {
      for (const email of result.renotifyEmails) {
        await this.emailQueue.add(
          'send-review-email',
          {
            to: email,
            orgSlug,
            orgName,
            token: rawToken,
            title: 'Approval payload updated — re-confirmation required',
            actionType: 'review.updated',
            summary: `Payload updated to version ${result.payloadVersion}.`,
            isRenotification: true,
          },
          { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true },
        );
      }
    }

    return {
      status: result.status,
      payload_version: result.payloadVersion,
    };
  }
}
