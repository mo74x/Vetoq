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
  Req,
  UseGuards,
} from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { apiKeys, projects, type HitlDb } from '@hitl/db';
import { AuthGuard, type AuthenticatedSession } from '../auth/auth.guard.js';
import { DB_TOKEN } from '../db/db.module.js';
import { CryptoService } from '../common/crypto.service.js';

@Controller('v1/dashboard/projects')
@UseGuards(AuthGuard)
export class ProjectsController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: HitlDb,
    private readonly crypto: CryptoService,
  ) {}

  private requireOrg(session: AuthenticatedSession): string {
    if (!session.activeOrganizationId) {
      throw new BadRequestException('No active organization selected');
    }
    return session.activeOrganizationId;
  }

  @Get()
  async list(@Req() req: { authSession: AuthenticatedSession }) {
    const orgId = this.requireOrg(req.authSession);
    return this.db
      .select({
        id: projects.id,
        orgId: projects.orgId,
        name: projects.name,
        defaultApproverEmails: projects.defaultApproverEmails,
        createdAt: projects.createdAt,
      })
      .from(projects)
      .where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt)))
      .orderBy(desc(projects.createdAt));
  }

  @Post()
  async create(
    @Req() req: { authSession: AuthenticatedSession },
    @Body() body: { name: string; default_approver_emails?: string[] },
  ) {
    const orgId = this.requireOrg(req.authSession);
    if (!body.name?.trim()) {
      throw new BadRequestException('Project name is required');
    }
    const rawSecret = `whsec_${this.crypto.randomToken(24)}`;
    const [created] = await this.db
      .insert(projects)
      .values({
        orgId,
        name: body.name.trim(),
        defaultApproverEmails: body.default_approver_emails ?? [],
        webhookSecretEnc: this.crypto.encryptSecret(rawSecret),
      })
      .returning({
        id: projects.id,
        orgId: projects.orgId,
        name: projects.name,
        defaultApproverEmails: projects.defaultApproverEmails,
        createdAt: projects.createdAt,
      });

    return { ...created, webhook_secret: rawSecret };
  }

  @Post(':projectId/rotate-webhook-secret')
  async rotateWebhookSecret(
    @Req() req: { authSession: AuthenticatedSession },
    @Param('projectId') projectId: string,
  ) {
    const orgId = this.requireOrg(req.authSession);
    const [project] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)))
      .limit(1);

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const nextSecret = `whsec_${this.crypto.randomToken(24)}`;
    await this.db
      .update(projects)
      .set({
        webhookSecretPrevEnc: project.webhookSecretEnc,
        webhookSecretEnc: this.crypto.encryptSecret(nextSecret),
      })
      .where(eq(projects.id, projectId));

    return { webhook_secret: nextSecret };
  }

  @Get(':projectId/api-keys')
  async listApiKeys(
    @Req() req: { authSession: AuthenticatedSession },
    @Param('projectId') projectId: string,
  ) {
    const orgId = this.requireOrg(req.authSession);
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)))
      .limit(1);
    if (!project) throw new NotFoundException('Project not found');

    return this.db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.projectId, projectId))
      .orderBy(desc(apiKeys.createdAt));
  }

  @Post(':projectId/api-keys')
  async createApiKey(
    @Req() req: { authSession: AuthenticatedSession },
    @Param('projectId') projectId: string,
    @Body() body: { name: string },
  ) {
    const orgId = this.requireOrg(req.authSession);
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)))
      .limit(1);
    if (!project) throw new NotFoundException('Project not found');

    const rawKey = `hk_live_${this.crypto.randomToken(24)}`;
    const keyPrefix = rawKey.slice(0, 12);

    const [created] = await this.db
      .insert(apiKeys)
      .values({
        projectId,
        name: body.name?.trim() || 'Default Key',
        keyPrefix,
        keyHash: this.crypto.sha256Hex(rawKey),
      })
      .returning({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        createdAt: apiKeys.createdAt,
      });

    return { ...created, api_key: rawKey };
  }

  @Delete(':projectId/api-keys/:keyId')
  async revokeApiKey(
    @Req() req: { authSession: AuthenticatedSession },
    @Param('projectId') projectId: string,
    @Param('keyId') keyId: string,
  ) {
    const orgId = this.requireOrg(req.authSession);
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)))
      .limit(1);
    if (!project) throw new NotFoundException('Project not found');

    await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.projectId, projectId)));

    return { revoked: true };
  }
}
