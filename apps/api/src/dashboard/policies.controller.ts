import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { circuitBreakers, policies, projects, type HitlDb } from '@hitl/db';
import { policyConditionSchema } from '@hitl/shared';
import { AuthGuard, type AuthenticatedSession } from '../auth/auth.guard.js';
import { DB_TOKEN } from '../db/db.module.js';
import { REDIS_TOKEN } from '../workers/queues.module.js';

@Controller('v1/dashboard/policies')
@UseGuards(AuthGuard)
export class PoliciesController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: HitlDb,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
  ) {}

  private async verifyProjectAccess(orgId: string | null, projectId: string) {
    if (!orgId) throw new BadRequestException('No active organization selected');
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)))
      .limit(1);
    if (!project) throw new NotFoundException('Project not found');
  }

  @Get()
  async list(
    @Req() req: { authSession: AuthenticatedSession },
    @Query('projectId') projectId: string,
  ) {
    await this.verifyProjectAccess(req.authSession.activeOrganizationId, projectId);
    return this.db
      .select()
      .from(policies)
      .where(eq(policies.projectId, projectId))
      .orderBy(asc(policies.priority));
  }

  @Post()
  async create(
    @Req() req: { authSession: AuthenticatedSession },
    @Body()
    body: {
      projectId: string;
      action_type: string;
      priority?: number;
      conditions?: unknown[];
      decision_mode: 'auto_approve' | 'require_approval' | 'auto_reject';
      required_approvals?: number;
      timeout_seconds?: number;
      require_otp?: boolean;
      approver_emails?: string[];
    },
  ) {
    await this.verifyProjectAccess(req.authSession.activeOrganizationId, body.projectId);
    const parsed = policyConditionSchema.array().safeParse(body.conditions ?? []);
    if (!parsed.success) {
      throw new BadRequestException({ message: 'Invalid conditions', issues: parsed.error.issues });
    }

    const [created] = await this.db
      .insert(policies)
      .values({
        projectId: body.projectId,
        actionType: body.action_type,
        priority: body.priority ?? 100,
        conditions: parsed.data,
        decisionMode: body.decision_mode,
        requiredApprovals: body.required_approvals ?? 1,
        timeoutSeconds: body.timeout_seconds ?? 3600,
        timeoutBehavior: 'reject',
        requireOtp: body.require_otp ?? false,
        approverEmails: body.approver_emails ?? [],
      })
      .returning();

    return created;
  }

  @Delete(':id')
  async remove(
    @Req() req: { authSession: AuthenticatedSession },
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    await this.verifyProjectAccess(req.authSession.activeOrganizationId, projectId);
    await this.db
      .delete(policies)
      .where(and(eq(policies.id, id), eq(policies.projectId, projectId)));
    return { deleted: true };
  }

  @Get('circuit-breakers')
  async listCircuitBreakers(
    @Req() req: { authSession: AuthenticatedSession },
    @Query('projectId') projectId: string,
  ) {
    await this.verifyProjectAccess(req.authSession.activeOrganizationId, projectId);
    return this.db
      .select()
      .from(circuitBreakers)
      .where(eq(circuitBreakers.projectId, projectId));
  }

  @Post('circuit-breakers')
  async upsertCircuitBreaker(
    @Req() req: { authSession: AuthenticatedSession },
    @Body()
    body: {
      projectId: string;
      action_type: string;
      max_requests_per_hour?: number | null;
      max_cumulative_amount_per_day?: number | null;
      amount_field?: string | null;
    },
  ) {
    await this.verifyProjectAccess(req.authSession.activeOrganizationId, body.projectId);
    const [existing] = await this.db
      .select()
      .from(circuitBreakers)
      .where(
        and(
          eq(circuitBreakers.projectId, body.projectId),
          eq(circuitBreakers.actionType, body.action_type),
        ),
      )
      .limit(1);

    if (existing) {
      const [updated] = await this.db
        .update(circuitBreakers)
        .set({
          maxRequestsPerHour: body.max_requests_per_hour ?? null,
          maxCumulativeAmountPerDay: body.max_cumulative_amount_per_day ?? null,
          amountField: body.amount_field ?? null,
        })
        .where(eq(circuitBreakers.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await this.db
      .insert(circuitBreakers)
      .values({
        projectId: body.projectId,
        actionType: body.action_type,
        maxRequestsPerHour: body.max_requests_per_hour ?? null,
        maxCumulativeAmountPerDay: body.max_cumulative_amount_per_day ?? null,
        amountField: body.amount_field ?? null,
      })
      .returning();
    return created;
  }

  @Post('circuit-breakers/:id/reset')
  async resetCircuitBreaker(
    @Req() req: { authSession: AuthenticatedSession },
    @Param('id') id: string,
    @Query('projectId') projectId: string,
  ) {
    await this.verifyProjectAccess(req.authSession.activeOrganizationId, projectId);
    const [breaker] = await this.db
      .update(circuitBreakers)
      .set({ isTripped: false, trippedAt: null, trippedReason: null })
      .where(and(eq(circuitBreakers.id, id), eq(circuitBreakers.projectId, projectId)))
      .returning();

    if (!breaker) throw new NotFoundException('Circuit breaker not found');
    await this.redis.del(
      `cb:req:${projectId}:${breaker.actionType}`,
      `cb:amt:${projectId}:${breaker.actionType}`,
    );
    return breaker;
  }
}
