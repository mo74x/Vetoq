import { Inject, OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { and, eq, lt } from 'drizzle-orm';
import { approvalRequests, webhookDeliveries, type HitlDb } from '@hitl/db';
import { DB_TOKEN } from '../db/db.module.js';
import { QUEUE_RECONCILIATION, QUEUE_TIMEOUTS, QUEUE_WEBHOOKS } from './queues.module.js';

@Processor(QUEUE_RECONCILIATION)
export class ReconciliationProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    @Inject(DB_TOKEN) private readonly db: HitlDb,
    @InjectQueue(QUEUE_RECONCILIATION) private readonly reconciliationQueue: Queue,
    @InjectQueue(QUEUE_TIMEOUTS) private readonly timeoutQueue: Queue,
    @InjectQueue(QUEUE_WEBHOOKS) private readonly webhookQueue: Queue,
  ) {
    super();
  }

  async onModuleInit() {
    await this.reconciliationQueue.add(
      'sweep',
      {},
      {
        jobId: 'reconciliation-sweep',
        repeat: { every: 15_000 },
        removeOnComplete: true,
      },
    );
  }

  async process(_job: Job): Promise<void> {
    const now = new Date();
    const expired = await this.db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.status, 'pending'), lt(approvalRequests.expiresAt, now)))
      .limit(50);

    for (const row of expired) {
      await this.timeoutQueue.add(
        'expire-approval',
        { approvalRequestId: row.id },
        { jobId: `timeout:${row.id}`, removeOnComplete: true },
      );
    }

    const tenSecondsAgo = new Date(Date.now() - 10_000);
    const orphanedWebhooks = await this.db
      .select({ id: webhookDeliveries.id, approvalRequestId: webhookDeliveries.approvalRequestId })
      .from(webhookDeliveries)
      .where(
        and(eq(webhookDeliveries.status, 'pending'), lt(webhookDeliveries.createdAt, tenSecondsAgo)),
      )
      .limit(50);

    for (const row of orphanedWebhooks) {
      await this.webhookQueue.add(
        'deliver-webhook',
        { deliveryId: row.id, approvalRequestId: row.approvalRequestId },
        {
          jobId: `webhook:${row.id}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 10000 },
          removeOnComplete: true,
        },
      );
    }
  }
}
