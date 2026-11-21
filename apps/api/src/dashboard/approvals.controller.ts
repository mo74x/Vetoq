import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { approvalRequests, projects, webhookDeliveries, type HitlDb } from '@hitl/db';
import { AuthGuard, type AuthenticatedSession } from '../auth/auth.guard.js';
import { DB_TOKEN } from '../db/db.module.js';

@Controller('v1/dashboard/approvals')
@UseGuards(AuthGuard)
export class DashboardApprovalsController {
  constructor(@Inject(DB_TOKEN) private readonly db: HitlDb) {}

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
}
