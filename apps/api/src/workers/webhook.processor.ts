import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { Inject } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import {
  approvalRequests,
  approvalVotes,
  auditLogs,
  projects,
  webhookDeliveries,
  type HitlDb,
} from '@hitl/db';
import { isBlockedIpAddress, type WebhookCallbackPayload } from '@hitl/shared';
import { DB_TOKEN } from '../db/db.module.js';
import { CryptoService } from '../common/crypto.service.js';
import { QUEUE_WEBHOOKS } from './queues.module.js';

@Processor(QUEUE_WEBHOOKS)
export class WebhookProcessor extends WorkerHost {
  constructor(
    @Inject(DB_TOKEN) private readonly db: HitlDb,
    private readonly crypto: CryptoService,
  ) {
    super();
  }

  private async postPinned(
    targetUrl: string,
    pinnedIp: string,
    ipFamily: 4 | 6,
    headers: Record<string, string>,
    body: string,
  ): Promise<{ status: number; body: string }> {
    const url = new URL(targetUrl);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port ? Number(url.port) : isHttps ? 443 : 80,
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: {
            ...headers,
            'Content-Length': String(Buffer.byteLength(body)),
          },
          timeout: 10_000,
          lookup: (_hostname, _opts, cb) => {
            cb(null, pinnedIp, ipFamily);
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          res.on('data', (chunk: Buffer) => {
            if (totalBytes < 4096) {
              chunks.push(chunk.subarray(0, 4096 - totalBytes));
              totalBytes += chunk.length;
            }
          });
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8').slice(0, 4096),
            });
          });
        },
      );

      req.on('timeout', () => {
        req.destroy(new Error('Webhook request timed out after 10s'));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async process(job: Job<{ deliveryId: string; approvalRequestId: string }>): Promise<void> {
    const { deliveryId, approvalRequestId } = job.data;

    const [row] = await this.db
      .select({
        delivery: webhookDeliveries,
        request: approvalRequests,
        project: projects,
      })
      .from(webhookDeliveries)
      .innerJoin(approvalRequests, eq(webhookDeliveries.approvalRequestId, approvalRequests.id))
      .innerJoin(projects, eq(approvalRequests.projectId, projects.id))
      .where(eq(webhookDeliveries.id, deliveryId))
      .limit(1);

    if (!row || row.delivery.status === 'succeeded') {
      return;
    }

    const url = new URL(row.request.callbackUrl);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let pinnedIp: string;
    let ipFamily: 4 | 6;

    try {
      const resolved = await dns.lookup(hostname);
      if (isBlockedIpAddress(resolved.address)) {
        await this.markPermanentFailure(
          deliveryId,
          approvalRequestId,
          row.project.id,
          null,
          'Blocked SSRF IP address',
        );
        throw new UnrecoverableError('Blocked SSRF IP address');
      }
      pinnedIp = resolved.address;
      ipFamily = resolved.family === 6 ? 6 : 4;
    } catch (err) {
      if (err instanceof UnrecoverableError) throw err;
      throw err;
    }

    const votes = await this.db
      .select()
      .from(approvalVotes)
      .where(eq(approvalVotes.approvalRequestId, approvalRequestId));
    const latestVote = votes.at(-1);

    const status = row.request.status as WebhookCallbackPayload['status'];
    const eventMap: Record<WebhookCallbackPayload['status'], WebhookCallbackPayload['event']> = {
      approved: 'approval.approved',
      edited_and_approved: 'approval.edited_and_approved',
      rejected: 'approval.rejected',
      timed_out: 'approval.timed_out',
    };

    const payload: WebhookCallbackPayload = {
      event: eventMap[status],
      request_id: row.request.id,
      action_type: row.request.actionType,
      status,
      decided_by: latestVote
        ? { name: latestVote.approverName, email: latestVote.approverEmail }
        : undefined,
      decision_note: latestVote?.note ?? undefined,
      original_payload: row.request.originalPayload,
      final_payload: row.request.finalPayload ?? row.request.originalPayload,
      decided_at: (row.request.decidedAt ?? new Date()).toISOString(),
    };

    const rawBody = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const secret = this.crypto.decryptSecret(row.project.webhookSecretEnc);
    const signature = this.crypto.signWebhookPayload(secret, timestamp, rawBody);

    const response = await this.postPinned(
      row.request.callbackUrl,
      pinnedIp,
      ipFamily,
      {
        'Content-Type': 'application/json',
        'X-HITL-Timestamp': String(timestamp),
        'X-Signature-256': signature,
      },
      rawBody,
    );

    const attemptNumber = (job.attemptsMade ?? 0) + 1;

    // Reject 3xx redirects and permanent 4xx errors (400/404/410)
    if (
      (response.status >= 300 && response.status < 400) ||
      response.status === 400 ||
      response.status === 404 ||
      response.status === 410
    ) {
      await this.markPermanentFailure(
        deliveryId,
        approvalRequestId,
        row.project.id,
        response.status,
        response.body,
        attemptNumber,
      );
      throw new UnrecoverableError(`Permanent webhook failure HTTP ${response.status}`);
    }

    if (response.status >= 200 && response.status < 300) {
      await this.db.transaction(async (tx) => {
        await tx
          .update(webhookDeliveries)
          .set({
            status: 'succeeded',
            httpStatus: response.status,
            responseBody: response.body,
            attemptNumber,
          })
          .where(eq(webhookDeliveries.id, deliveryId));

        await tx
          .update(approvalRequests)
          .set({ deliveryStatus: 'delivered' })
          .where(eq(approvalRequests.id, approvalRequestId));

        await tx.insert(auditLogs).values({
          projectId: row.project.id,
          approvalRequestId,
          eventType: 'webhook_succeeded',
          actorType: 'system',
          actorIdentifier: 'webhook-worker',
          metadata: { http_status: response.status, attempt: attemptNumber },
        });
      });
      return;
    }

    // Transient 429/5xx -> record attempt and throw to trigger BullMQ retry
    await this.db
      .update(webhookDeliveries)
      .set({
        attemptNumber,
        httpStatus: response.status,
        responseBody: response.body,
      })
      .where(eq(webhookDeliveries.id, deliveryId));

    throw new Error(`Transient webhook failure HTTP ${response.status}`);
  }

  private async markPermanentFailure(
    deliveryId: string,
    approvalRequestId: string,
    projectId: string,
    httpStatus: number | null,
    responseBody: string,
    attemptNumber = 1,
  ) {
    await this.db.transaction(async (tx) => {
      await tx
        .update(webhookDeliveries)
        .set({
          status: 'failed',
          httpStatus,
          responseBody: responseBody.slice(0, 4096),
          attemptNumber,
        })
        .where(eq(webhookDeliveries.id, deliveryId));

      await tx
        .update(approvalRequests)
        .set({ deliveryStatus: 'delivery_failed' })
        .where(eq(approvalRequests.id, approvalRequestId));

      await tx.insert(auditLogs).values({
        projectId,
        approvalRequestId,
        eventType: 'webhook_failed',
        actorType: 'system',
        actorIdentifier: 'webhook-worker',
        metadata: { http_status: httpStatus, reason: responseBody.slice(0, 256) },
      });
    });
  }
}
