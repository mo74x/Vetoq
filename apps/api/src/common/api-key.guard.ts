import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { apiKeys, projects, type HitlDb } from '@hitl/db';
import { DB_TOKEN } from '../db/db.module.js';
import { CryptoService } from './crypto.service.js';

export interface AuthenticatedProject {
  projectId: string;
  orgId: string;
  apiKeyId: string;
  keyPrefix: string;
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @Inject(DB_TOKEN) private readonly db: HitlDb,
    private readonly crypto: CryptoService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const authHeader: string | undefined = req.headers?.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing Bearer API key');
    }

    const rawKey = authHeader.slice('Bearer '.length).trim();
    if (!rawKey) {
      throw new UnauthorizedException('Empty API key');
    }

    const keyHash = this.crypto.sha256Hex(rawKey);
    const [row] = await this.db
      .select({
        apiKeyId: apiKeys.id,
        keyPrefix: apiKeys.keyPrefix,
        projectId: projects.id,
        orgId: projects.orgId,
      })
      .from(apiKeys)
      .innerJoin(projects, eq(apiKeys.projectId, projects.id))
      .where(
        and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt), isNull(projects.deletedAt)),
      )
      .limit(1);

    if (!row) {
      throw new UnauthorizedException('Invalid or revoked API key');
    }

    await this.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, row.apiKeyId));

    req.projectAuth = {
      projectId: row.projectId,
      orgId: row.orgId,
      apiKeyId: row.apiKeyId,
      keyPrefix: row.keyPrefix,
    } satisfies AuthenticatedProject;

    return true;
  }
}
