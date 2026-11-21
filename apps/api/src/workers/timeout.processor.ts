import { Inject } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import {
  approvalRequests,
  approvalTokens,
  auditLogs,
  webhookDeliveries,
  type HitlDb,
} from '@hitl/db';
import { DB_TOKEN } from '../db/db.module.js';
import { QUEUE_TIMEOUTS, QUEUE_WEBHOOKS } from './queues.module.js';

@Processor(QUEUE_TIMEOUTS)
export class TimeoutProcessor extends WorkerHost {
  constructor(
    @Inject(DB_TOKEN) private readonly db: HitlDb,
    @InjectQueue(QUEUE_WEBHOOKS) private readonly webhookQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<{ approvalRequestId: string }>): Promise<void> {
    const { approvalRequestId } = job.data;

    const deliveryId = await this.db.transaction(async (tx) => {
      const locked = await tx.execute(
        sql`SELECT * FROM approval_requests WHERE id = ${approvalRequestId} FOR UPDATE`,
      );
      const row = locked.rows[0] as Record<string, unknown> | undefined;
      if (!row || row.status !== 'pending') {
        return null;
      }

      await tx
        .update(approvalRequests)
        .set({
          status: 'timed_out',
          deliveryStatus: 'pending',
          decidedAt: new Date(),
        })
        .where(eq(approvalRequests.id, approvalRequestId));

      await tx
        .update(approvalTokens)
        .set({ usedAt: new Date() })
        .where(eq(approvalTokens.approvalRequestId, approvalRequestId));

      await tx.insert(auditLogs).values({
        projectId: String(row.project_id),
        approvalRequestId,
        eventType: 'timed_out',
        actorType: 'system',
        actorIdentifier: 'timeout-worker',
      });

      const [delivery] = await tx
        .insert(webhookDeliveries)
        .values({
          approvalRequestId,
          callbackUrl: String(row.callback_url),
          status: 'pending',
        })
        .returning();

      return delivery.id;
    });

    if (deliveryId) {
      await this.webhookQueue.add(
        'deliver-webhook',
        { deliveryId, approvalRequestId },
        { attempts: 5, backoff: { type: 'exponential', delay: 10000 }, removeOnComplete: true },
      );
    }
  }
}
