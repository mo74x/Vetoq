import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  approvalRequests,
  approvalTokens,
  auditLogs,
  members,
  organizations,
  policies,
  projects,
  users,
  type HitlDb,
} from '@hitl/db';
import {
  evaluatePolicies,
  validateCallbackUrlSyntax,
  type CreateApprovalRequest,
  type PolicyRule,
} from '@hitl/shared';
import { DB_TOKEN } from '../db/db.module.js';
import { CryptoService } from '../common/crypto.service.js';
import { getPlanLimits } from '../common/plan-limits.js';
import { SlackService } from '../slack/slack.service.js';
import { QUEUE_EMAILS, QUEUE_TIMEOUTS } from '../workers/queues.module.js';

@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: HitlDb,
    private readonly crypto: CryptoService,
    private readonly slackService: SlackService,
    @InjectQueue(QUEUE_TIMEOUTS) private readonly timeoutQueue: Queue,
    @InjectQueue(QUEUE_EMAILS) private readonly emailQueue: Queue,
  ) {}

  private async resolveFallbackApprovers(projectId: string, orgId: string): Promise<string[]> {
    const [project] = await this.db
      .select({ defaultApproverEmails: projects.defaultApproverEmails })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (project && project.defaultApproverEmails.length > 0) {
      return project.defaultApproverEmails;
    }

    const admins = await this.db
      .select({ email: users.email })
      .from(members)
      .innerJoin(users, eq(members.userId, users.id))
      .where(and(eq(members.organizationId, orgId), inArray(members.role, ['owner', 'admin'])));

    return admins.map((a) => a.email);
  }

  async createApproval(
    projectId: string,
    orgId: string,
    keyPrefix: string,
    body: CreateApprovalRequest,
    idempotencyKey?: string,
  ) {
    const urlCheck = validateCallbackUrlSyntax(body.callback_url);
    if (!urlCheck.valid) {
      throw new BadRequestException(urlCheck.reason ?? 'Invalid callback_url');
    }

    const requestHash = idempotencyKey
      ? this.crypto.sha256Hex(JSON.stringify(body))
      : null;

    if (idempotencyKey) {
      const [existing] = await this.db
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.projectId, projectId),
            eq(approvalRequests.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);

      if (existing) {
        if (existing.idempotencyRequestHash !== requestHash) {
          throw new ConflictException(
            'Idempotency-Key reused with a different request payload',
          );
        }
        if (existing.status === 'auto_approved' || existing.status === 'auto_rejected') {
          return {
            httpStatus: 200 as const,
            data: {
              id: existing.id,
              status: existing.status,
              final_payload: existing.finalPayload,
            },
          };
        }
        return {
          httpStatus: 202 as const,
          data: {
            id: existing.id,
            status: existing.status,
            expires_at: existing.expiresAt.toISOString(),
          },
        };
      }
    }

    const [org] = await this.db
      .select({ slug: organizations.slug, name: organizations.name, plan: organizations.plan })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    if (org) {
      const limits = getPlanLimits(org.plan);
      if (limits.monthlyApprovals !== null) {
        const monthStart = new Date();
        monthStart.setUTCDate(1);
        monthStart.setUTCHours(0, 0, 0, 0);

        const [countRow] = await this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(approvalRequests)
          .innerJoin(projects, eq(approvalRequests.projectId, projects.id))
          .where(
            and(
              eq(projects.orgId, orgId),
              gte(approvalRequests.createdAt, monthStart),
            ),
          );

        if ((countRow?.count ?? 0) >= limits.monthlyApprovals) {
          throw new ForbiddenException(
            `Monthly approval quota (${limits.monthlyApprovals}) reached for plan "${org.plan}"`,
          );
        }
      }
    }

    const dbPolicies = await this.db
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

    const evaluation = evaluatePolicies(
      body.action_type,
      body.payload,
      policyRules,
      body.timeout_seconds ?? 3600,
    );

    const effectiveTimeout = body.timeout_seconds ?? evaluation.timeout_seconds;
    const expiresAt = new Date(Date.now() + effectiveTimeout * 1000);

    if (evaluation.decision_mode === 'auto_approve' || evaluation.decision_mode === 'auto_reject') {
      const terminalStatus =
        evaluation.decision_mode === 'auto_approve' ? 'auto_approved' : 'auto_rejected';

      const [created] = await this.db.transaction(async (tx) => {
        const [reqRow] = await tx
          .insert(approvalRequests)
          .values({
            projectId,
            policyId: evaluation.matched_policy_id,
            initialPolicySnapshot: evaluation.matched_policy_snapshot as Record<string, unknown> | null,
            effectivePolicySnapshot: evaluation.matched_policy_snapshot as Record<string, unknown> | null,
            idempotencyKey: idempotencyKey ?? null,
            idempotencyRequestHash: requestHash,
            actionType: body.action_type,
            title: body.title,
            summary: body.summary ?? null,
            agentName: body.agent_name ?? null,
            originalPayload: body.payload,
            finalPayload: body.payload,
            editableSchema: (body.editable_schema as Record<string, unknown> | undefined) ?? null,
            requiredApprovals: evaluation.required_approvals,
            status: terminalStatus,
            deliveryStatus: 'not_applicable',
            callbackUrl: body.callback_url,
            expiresAt,
            decidedAt: new Date(),
          })
          .returning();

        await tx.insert(auditLogs).values([
          {
            projectId,
            approvalRequestId: reqRow.id,
            eventType: 'created',
            actorType: 'agent',
            actorIdentifier: body.agent_name ?? keyPrefix,
            metadata: { action_type: body.action_type },
          },
          {
            projectId,
            approvalRequestId: reqRow.id,
            eventType: terminalStatus,
            actorType: 'system',
            actorIdentifier: 'policy-engine',
            metadata: { matched_policy_id: evaluation.matched_policy_id },
          },
        ]);

        return [reqRow];
      });

      return {
        httpStatus: 200 as const,
        data: {
          id: created.id,
          status: created.status,
          final_payload: created.finalPayload,
        },
      };
    }

    // require_approval path
    const approverEmails =
      evaluation.approver_emails.length > 0
        ? evaluation.approver_emails
        : await this.resolveFallbackApprovers(projectId, orgId);

    const tokensToEmail: Array<{ email: string; rawToken: string }> = [];

    const created = await this.db.transaction(async (tx) => {
      const [reqRow] = await tx
        .insert(approvalRequests)
        .values({
          projectId,
          policyId: evaluation.matched_policy_id,
          initialPolicySnapshot: evaluation.matched_policy_snapshot as Record<string, unknown> | null,
          effectivePolicySnapshot: evaluation.matched_policy_snapshot as Record<string, unknown> | null,
          idempotencyKey: idempotencyKey ?? null,
          idempotencyRequestHash: requestHash,
          actionType: body.action_type,
          title: body.title,
          summary: body.summary ?? null,
          agentName: body.agent_name ?? null,
          originalPayload: body.payload,
          finalPayload: body.payload,
          editableSchema: (body.editable_schema as Record<string, unknown> | undefined) ?? null,
          requiredApprovals: evaluation.required_approvals,
          status: 'pending',
          deliveryStatus: 'not_applicable',
          callbackUrl: body.callback_url,
          expiresAt,
        })
        .returning();

      for (const email of approverEmails) {
        const rawToken = this.crypto.randomToken(32);
        tokensToEmail.push({ email, rawToken });
        await tx.insert(approvalTokens).values({
          approvalRequestId: reqRow.id,
          approverEmail: email,
          tokenHash: this.crypto.sha256Hex(rawToken),
          expiresAt,
        });
      }

      await tx.insert(auditLogs).values([
        {
          projectId,
          approvalRequestId: reqRow.id,
          eventType: 'created',
          actorType: 'agent',
          actorIdentifier: body.agent_name ?? keyPrefix,
          metadata: { action_type: body.action_type },
        },
        {
          projectId,
          approvalRequestId: reqRow.id,
          eventType: 'policy_matched',
          actorType: 'system',
          actorIdentifier: 'policy-engine',
          metadata: {
            matched_policy_id: evaluation.matched_policy_id,
            fallback_reason: evaluation.fallback_reason ?? null,
            required_approvals: evaluation.required_approvals,
          },
        },
      ]);

      return reqRow;
    });

    await this.timeoutQueue.add(
      'expire-approval',
      { approvalRequestId: created.id },
      {
        jobId: `timeout_${created.id}`,
        delay: Math.max(1000, effectiveTimeout * 1000),
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    if (org) {
      for (const item of tokensToEmail) {
        await this.emailQueue.add(
          'send-review-email',
          {
            to: item.email,
            orgSlug: org.slug,
            orgName: org.name,
            token: item.rawToken,
            title: created.title,
            actionType: created.actionType,
            summary: created.summary,
            isRenotification: false,
          },
          { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true },
        );
      }
    }

    const [projSlack] = await this.db
      .select({
        slackBotTokenEnc: projects.slackBotTokenEnc,
        defaultSlackChannel: projects.defaultSlackChannel,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (projSlack?.slackBotTokenEnc && projSlack.defaultSlackChannel) {
      const botToken = this.crypto.decryptSecret(projSlack.slackBotTokenEnc);
      void this.slackService
        .postApprovalCard({
          botToken,
          channel: projSlack.defaultSlackChannel,
          requestId: created.id,
          title: created.title,
          actionType: created.actionType,
          summary: created.summary,
          payload: created.originalPayload,
          hasEditableSchema: Boolean(created.editableSchema),
        })
        .catch(() => undefined);
    }

    return {
      httpStatus: 202 as const,
      data: {
        id: created.id,
        status: created.status,
        expires_at: created.expiresAt.toISOString(),
      },
    };
  }

  async getApprovalById(projectId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.id, id), eq(approvalRequests.projectId, projectId)))
      .limit(1);

    if (!row) {
      throw new NotFoundException('Approval request not found');
    }
    return row;
  }

  async listApprovals(projectId: string, limit = 50) {
    return this.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.projectId, projectId))
      .orderBy(desc(approvalRequests.createdAt))
      .limit(limit);
  }
}
