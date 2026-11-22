import { Module } from '@nestjs/common';
import type { HitlDb } from '@hitl/db';
import { DbModule, DB_TOKEN } from './db/db.module.js';
import { QueuesModule } from './workers/queues.module.js';
import { CryptoService } from './common/crypto.service.js';
import { ApiKeyGuard } from './common/api-key.guard.js';
import { RateLimitGuard } from './common/rate-limit.guard.js';
import { createBetterAuth } from './auth/auth.js';
import { AuthGuard, BETTER_AUTH_TOKEN } from './auth/auth.guard.js';
import { ApprovalsService } from './approvals/approvals.service.js';
import { ApprovalsController } from './approvals/approvals.controller.js';
import { ReviewService } from './review/review.service.js';
import { ReviewController } from './review/review.controller.js';
import { ProjectsController } from './dashboard/projects.controller.js';
import { PoliciesController } from './dashboard/policies.controller.js';
import { DashboardApprovalsController } from './dashboard/approvals.controller.js';
import { AuditController } from './dashboard/audit.controller.js';
import { HealthController } from './health/health.controller.js';
import { BillingWebhookController } from './billing/billing-webhook.controller.js';
import { TimeoutProcessor } from './workers/timeout.processor.js';
import { WebhookProcessor } from './workers/webhook.processor.js';
import { EmailProcessor } from './workers/email.processor.js';
import { ReconciliationProcessor } from './workers/reconciliation.processor.js';

@Module({
  imports: [DbModule, QueuesModule],
  controllers: [
    HealthController,
    BillingWebhookController,
    ApprovalsController,
    ReviewController,
    ProjectsController,
    PoliciesController,
    DashboardApprovalsController,
    AuditController,
  ],
  providers: [
    CryptoService,
    ApiKeyGuard,
    RateLimitGuard,
    {
      provide: BETTER_AUTH_TOKEN,
      inject: [DB_TOKEN],
      useFactory: (db: HitlDb) => createBetterAuth(db),
    },
    AuthGuard,
    ApprovalsService,
    ReviewService,
    TimeoutProcessor,
    WebhookProcessor,
    EmailProcessor,
    ReconciliationProcessor,
  ],
})
export class AppModule {}
