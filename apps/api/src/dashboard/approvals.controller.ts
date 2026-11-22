import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { approvalRequests, projects, webhookDeliveries, type HitlDb } from '@hitl/db';
import { AuthGuard, type AuthenticatedSession } from '../auth/auth.guard.js';
import { DB_TOKEN } from '../db/db.module.js';
import { QUEUE_WEBHOOKS } from '../workers/queues.module.js';

@Controller('v1/dashboard/approvals')
@UseGuards(AuthGuard)
export class DashboardApprovalsController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: HitlDb,
    @InjectQueue(QUEUE_WEBHOOKS) private readonly webhookQueue: Queue,
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
  async listApprovals(
    @Req() req: { authSession: AuthenticatedSession },
    @Query('projectId') projectId: string,
  ) {
    await this.verifyProjectAccess(req.authSession.activeOrganizationId, projectId);
    return this.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.projectId, projectId))
      .orderBy(desc(approvalRequests.createdAt))
      .limit(100);
  }

  @Get('webhooks')
  async listWebhookDeliveries(
    @Req() req: { authSession: AuthenticatedSession },
    @Query('projectId') projectId: string,
  ) {
    await this.verifyProjectAccess(req.authSession.activeOrganizationId, projectId);
    return this.db
      .select({
        id: webhookDeliveries.id,
        approvalRequestId: webhookDeliveries.approvalRequestId,
        callbackUrl: webhookDeliveries.callbackUrl,
        attemptNumber: webhookDeliveries.attemptNumber,
        httpStatus: webhookDeliveries.httpStatus,
        responseBody: webhookDeliveries.responseBody,
        status: webhookDeliveries.status,
        createdAt: webhookDeliveries.createdAt,
      })
      .from(webhookDeliveries)
      .innerJoin(approvalRequests, eq(webhookDeliveries.approvalRequestId, approvalRequests.id))
      .where(eq(approvalRequests.projectId, projectId))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(100);
  }

  @Post('webhooks/:deliveryId/retry')
  async retryWebhook(
    @Req() req: { authSession: AuthenticatedSession },
    @Param('deliveryId') deliveryId: string,
  ) {
    const orgId = req.authSession.activeOrganizationId;
    if (!orgId) throw new BadRequestException('No active organization selected');

    const [row] = await this.db
      .select({
        deliveryId: webhookDeliveries.id,
        approvalRequestId: webhookDeliveries.approvalRequestId,
      })
      .from(webhookDeliveries)
      .innerJoin(approvalRequests, eq(webhookDeliveries.approvalRequestId, approvalRequests.id))
      .innerJoin(projects, eq(approvalRequests.projectId, projects.id))
      .where(and(eq(webhookDeliveries.id, deliveryId), eq(projects.orgId, orgId)))
      .limit(1);

    if (!row) throw new NotFoundException('Webhook delivery not found');

    await this.db.transaction(async (tx) => {
      await tx
        .update(webhookDeliveries)
        .set({ status: 'pending', httpStatus: null })
        .where(eq(webhookDeliveries.id, row.deliveryId));

      await tx
        .update(approvalRequests)
        .set({ deliveryStatus: 'pending' })
        .where(eq(approvalRequests.id, row.approvalRequestId));
    });

    await this.webhookQueue.add(
      'deliver-webhook',
      { deliveryId: row.deliveryId, approvalRequestId: row.approvalRequestId },
      { attempts: 5, backoff: { type: 'exponential', delay: 10000 }, removeOnComplete: true },
    );

    return { queued: true, delivery_id: row.deliveryId };
  }
}
