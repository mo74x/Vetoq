import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import {
  approvalRequests,
  approvalVotes,
  auditLogs,
  projects,
  webhookDeliveries,
  type HitlDb,
} from '@hitl/db';
import { AuthGuard, type AuthenticatedSession } from '../auth/auth.guard.js';
import { DB_TOKEN } from '../db/db.module.js';

@Controller('v1/dashboard/audit')
@UseGuards(AuthGuard)
export class AuditController {
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
  async list(
    @Req() req: { authSession: AuthenticatedSession },
    @Query('projectId') projectId: string,
  ) {
    await this.verifyProjectAccess(req.authSession.activeOrganizationId, projectId);
    return this.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.projectId, projectId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(200);
  }

  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportCsv(
    @Req() req: { authSession: AuthenticatedSession },
    @Query('projectId') projectId: string,
    @Res() res: Response,
  ) {
    await this.verifyProjectAccess(req.authSession.activeOrganizationId, projectId);
    const rows = await this.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.projectId, projectId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1000);

    const header = 'id,approval_request_id,event_type,actor_type,actor_identifier,created_at\n';
    const lines = rows.map(
      (r) =>
        `"${r.id}","${r.approvalRequestId}","${r.eventType}","${r.actorType}","${r.actorIdentifier.replace(/"/g, '""')}","${r.createdAt.toISOString()}"`,
    );
    res.setHeader('Content-Disposition', `attachment; filename="audit-${projectId}.csv"`);
    return res.send(header + lines.join('\n'));
  }

  @Get('evidence/:approvalRequestId')
  async exportEvidencePack(
    @Req() req: { authSession: AuthenticatedSession },
    @Param('approvalRequestId') approvalRequestId: string,
  ) {
    const orgId = req.authSession.activeOrganizationId;
    if (!orgId) throw new BadRequestException('No active organization selected');

    const [row] = await this.db
      .select({ request: approvalRequests, projectName: projects.name })
      .from(approvalRequests)
      .innerJoin(projects, eq(approvalRequests.projectId, projects.id))
      .where(
        and(eq(approvalRequests.id, approvalRequestId), eq(projects.orgId, orgId)),
      )
      .limit(1);

    if (!row) throw new NotFoundException('Approval request not found');

    const [votes, timeline, deliveries] = await Promise.all([
      this.db
        .select()
        .from(approvalVotes)
        .where(eq(approvalVotes.approvalRequestId, approvalRequestId))
        .orderBy(asc(approvalVotes.createdAt)),
      this.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.approvalRequestId, approvalRequestId))
        .orderBy(asc(auditLogs.createdAt)),
      this.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.approvalRequestId, approvalRequestId))
        .orderBy(asc(webhookDeliveries.createdAt)),
    ]);

    return {
      schema_version: 'vetoq.evidence.v1',
      generated_at: new Date().toISOString(),
      project_name: row.projectName,
      request: row.request,
      votes,
      audit_timeline: timeline,
      webhook_deliveries: deliveries,
    };
  }
}
