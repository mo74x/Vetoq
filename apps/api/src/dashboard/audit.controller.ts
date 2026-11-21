import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { auditLogs, projects, type HitlDb } from '@hitl/db';
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
}
