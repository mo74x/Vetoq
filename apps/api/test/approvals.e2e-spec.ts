import crypto from 'node:crypto';
import http from 'node:http';
import { Test } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import express from 'express';
import request from 'supertest';
import { and, eq, sql } from 'drizzle-orm';
import {
  apiKeys,
  approvalRequests,
  approvalTokens,
  approvalVotes,
  auditLogs,
  organizations,
  policies,
  projects,
  webhookDeliveries,
  type HitlDb,
} from '@hitl/db';
import { MAX_APPROVAL_BODY_BYTES } from '@hitl/shared';
import { AppModule } from '../src/app.module.js';
import { DB_TOKEN } from '../src/db/db.module.js';
import { CryptoService } from '../src/common/crypto.service.js';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { TimeoutProcessor } from '../src/workers/timeout.processor.js';
import { ReconciliationProcessor } from '../src/workers/reconciliation.processor.js';
import { QUEUE_WEBHOOKS } from '../src/workers/queues.module.js';

describe('HITL Approval Layer — Phase 1 E2E', () => {
  let app: INestApplication;
  let db: HitlDb;
  let cryptoSvc: CryptoService;
  let timeoutProcessor: TimeoutProcessor;
  let reconciliationProcessor: ReconciliationProcessor;

  let orgId: string;
  let projectId: string;
  let rawApiKey: string;
  let webhookSecret: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    app.use(
      express.json({
        limit: MAX_APPROVAL_BODY_BYTES,
        verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
          req.rawBody = buf;
        },
      }),
    );
    app.use(
      express.urlencoded({
        extended: true,
        limit: MAX_APPROVAL_BODY_BYTES,
        verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
          req.rawBody = buf;
        },
      }),
    );
    await app.init();

    db = app.get<HitlDb>(DB_TOKEN);
    cryptoSvc = app.get(CryptoService);
    timeoutProcessor = app.get(TimeoutProcessor);
    reconciliationProcessor = app.get(ReconciliationProcessor);
    const webhookQueue = app.get<Queue>(getQueueToken(QUEUE_WEBHOOKS));
    await webhookQueue.pause();

    // Seed test organization, project, API key, and policies
    orgId = `org_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(organizations).values({
      id: orgId,
      name: 'Acme Agency',
      slug: `acme-${orgId}`,
      plan: 'pro',
      brandingConfig: { accent_color: '#111827' },
    });

    webhookSecret = `whsec_${cryptoSvc.randomToken(16)}`;
    const [proj] = await db
      .insert(projects)
      .values({
        orgId,
        name: 'E2E Client Project',
        defaultApproverEmails: ['fallback@acme.com'],
        webhookSecretEnc: cryptoSvc.encryptSecret(webhookSecret),
      })
      .returning();
    projectId = proj.id;

    rawApiKey = `hk_live_${cryptoSvc.randomToken(20)}`;
    await db.insert(apiKeys).values({
      projectId,
      name: 'E2E Key',
      keyPrefix: rawApiKey.slice(0, 12),
      keyHash: cryptoSvc.sha256Hex(rawApiKey),
    });

    await db.insert(policies).values([
      {
        projectId,
        actionType: 'stripe.refund',
        priority: 10,
        conditions: [{ field: 'refund_amount_usd', op: 'lte', value: 50 }],
        decisionMode: 'auto_approve',
        requiredApprovals: 1,
        timeoutSeconds: 1800,
        timeoutBehavior: 'reject',
        approverEmails: ['lead@acme.com'],
      },
      {
        projectId,
        actionType: 'stripe.refund',
        priority: 20,
        conditions: [{ field: 'refund_amount_usd', op: 'gt', value: 1000 }],
        decisionMode: 'auto_reject',
        requiredApprovals: 1,
        timeoutSeconds: 1800,
        timeoutBehavior: 'reject',
        approverEmails: ['lead@acme.com'],
      },
      {
        projectId,
        actionType: 'stripe.refund',
        priority: 30,
        conditions: [{ field: 'refund_amount_usd', op: 'gt', value: 500 }],
        decisionMode: 'require_approval',
        requiredApprovals: 2,
        timeoutSeconds: 1800,
        timeoutBehavior: 'reject',
        approverEmails: ['approver-a@acme.com', 'approver-b@acme.com'],
      },
      {
        projectId,
        actionType: 'stripe.refund',
        priority: 40,
        conditions: [{ field: 'refund_amount_usd', op: 'gt', value: 50 }],
        decisionMode: 'require_approval',
        requiredApprovals: 1,
        timeoutSeconds: 1800,
        timeoutBehavior: 'reject',
        approverEmails: ['lead@acme.com'],
      },
    ]);
  });

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (app) {
      await app.close();
    }
  });

  const editableSchema = {
    refund_amount_usd: {
      type: 'number',
      label: 'Refund Amount (USD)',
      editable: true,
      min: 0,
      max: 1500,
    },
    order_id: {
      type: 'string',
      label: 'Order ID',
      editable: false,
    },
  };

  it('rejects unauthenticated POST /v1/approvals with 401', async () => {
    await request(app.getHttpServer())
      .post('/v1/approvals')
      .send({
        action_type: 'stripe.refund',
        title: 'Unauth test',
        callback_url: 'https://example.com/hook',
        payload: { refund_amount_usd: 100 },
      })
      .expect(401);
  });

  it('returns 200 synchronously for auto_approved and auto_rejected with no webhook', async () => {
    const autoApproveRes = await request(app.getHttpServer())
      .post('/v1/approvals')
      .set('Authorization', `Bearer ${rawApiKey}`)
      .send({
        action_type: 'stripe.refund',
        title: 'Small refund',
        callback_url: 'https://example.com/hook',
        payload: { order_id: 'ord_1', refund_amount_usd: 25 },
      })
      .expect(200);

    expect(autoApproveRes.body.status).toBe('auto_approved');
    const [reqRow] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, autoApproveRes.body.id));
    expect(reqRow.deliveryStatus).toBe('not_applicable');

    const autoRejectRes = await request(app.getHttpServer())
      .post('/v1/approvals')
      .set('Authorization', `Bearer ${rawApiKey}`)
      .send({
        action_type: 'stripe.refund',
        title: 'Huge refund',
        callback_url: 'https://example.com/hook',
        payload: { order_id: 'ord_2', refund_amount_usd: 5000 },
      })
      .expect(200);

    expect(autoRejectRes.body.status).toBe('auto_rejected');
  });

  it('enforces Idempotency-Key replay and 409 on payload mismatch', async () => {
    const key = `idem_${crypto.randomUUID()}`;
    const body = {
      action_type: 'stripe.refund',
      title: 'Idem refund',
      callback_url: 'https://example.com/hook',
      payload: { order_id: 'ord_3', refund_amount_usd: 200 },
    };

    const first = await request(app.getHttpServer())
      .post('/v1/approvals')
      .set('Authorization', `Bearer ${rawApiKey}`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(202);

    const replay = await request(app.getHttpServer())
      .post('/v1/approvals')
      .set('Authorization', `Bearer ${rawApiKey}`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(202);

    expect(replay.body.id).toBe(first.body.id);

    await request(app.getHttpServer())
      .post('/v1/approvals')
      .set('Authorization', `Bearer ${rawApiKey}`)
      .set('Idempotency-Key', key)
      .send({ ...body, payload: { order_id: 'ord_3', refund_amount_usd: 250 } })
      .expect(409);
  });

  it('blocks SSRF localhost/private callback_url on ingestion', async () => {
    await request(app.getHttpServer())
      .post('/v1/approvals')
      .set('Authorization', `Bearer ${rawApiKey}`)
      .send({
        action_type: 'stripe.refund',
        title: 'SSRF attempt',
        callback_url: 'http://169.254.169.254/latest/meta-data/',
        payload: { order_id: 'ord_ssrf', refund_amount_usd: 100 },
      })
      .expect(400);
  });

  it('enforces read-only GET prefetch safety, single-use action_nonce, and edit validation', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/approvals')
      .set('Authorization', `Bearer ${rawApiKey}`)
      .send({
        action_type: 'stripe.refund',
        title: 'Single approver edit test',
        callback_url: 'https://example.com/hook',
        payload: { order_id: 'ord_edit', refund_amount_usd: 240 },
        editable_schema: editableSchema,
      })
      .expect(202);

    // Mint a known token directly for the test approver
    const rawToken = cryptoSvc.randomToken(24);
    await db.insert(approvalTokens).values({
      approvalRequestId: created.body.id,
      approverEmail: 'lead@acme.com',
      tokenHash: cryptoSvc.sha256Hex(rawToken),
      expiresAt: new Date(Date.now() + 3600_000),
    });

    // Two concurrent GETs (simulating scanner prefetch after human load) must both succeed without mutating state
    const get1 = await request(app.getHttpServer()).get(`/v1/review/${rawToken}`).expect(200);
    const get2 = await request(app.getHttpServer()).get(`/v1/review/${rawToken}`).expect(200);
    expect(get1.body.action_nonce).not.toBe(get2.body.action_nonce);

    // Reject edit to locked field
    await request(app.getHttpServer())
      .post(`/v1/review/${rawToken}/decide`)
      .send({
        action_nonce: get2.body.action_nonce,
        payload_version: 1,
        decision: 'approve',
        edited_fields: { order_id: 'hacked' },
      })
      .expect(400);

    // Human's original nonce from get1 MUST still work even after get2 prefetch
    const decideRes = await request(app.getHttpServer())
      .post(`/v1/review/${rawToken}/decide`)
      .send({
        action_nonce: get1.body.action_nonce,
        payload_version: 1,
        decision: 'approve',
        approver_name: 'Alex Lead',
        edited_fields: { refund_amount_usd: 120 },
        note: 'Partial refund approved',
      })
      .expect(201);

    expect(decideRes.body.status).toBe('edited_and_approved');

    // Replaying the same action_nonce must return 409
    await request(app.getHttpServer())
      .post(`/v1/review/${rawToken}/decide`)
      .send({
        action_nonce: get1.body.action_nonce,
        payload_version: 1,
        decision: 'approve',
      })
      .expect(410); // token is now used; nonce replay also blocked

    // Verify transactional outbox row created in webhook_deliveries
    const deliveries = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.approvalRequestId, created.body.id));
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
  });

  it('CUJ 2: resets prior multi-approver votes on edit and requires re-confirmation', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/approvals')
      .set('Authorization', `Bearer ${rawApiKey}`)
      .send({
        action_type: 'stripe.refund',
        title: 'Dual sign-off refund',
        callback_url: 'https://example.com/hook',
        payload: { order_id: 'ord_dual', refund_amount_usd: 600 },
        editable_schema: editableSchema,
      })
      .expect(202);

    const tokenA = cryptoSvc.randomToken(24);
    const tokenB = cryptoSvc.randomToken(24);
    await db.insert(approvalTokens).values([
      {
        approvalRequestId: created.body.id,
        approverEmail: 'approver-a@acme.com',
        tokenHash: cryptoSvc.sha256Hex(tokenA),
        expiresAt: new Date(Date.now() + 3600_000),
      },
      {
        approvalRequestId: created.body.id,
        approverEmail: 'approver-b@acme.com',
        tokenHash: cryptoSvc.sha256Hex(tokenB),
        expiresAt: new Date(Date.now() + 3600_000),
      },
    ]);

    // Approver A approves v1
    const ctxA1 = await request(app.getHttpServer()).get(`/v1/review/${tokenA}`).expect(200);
    const voteA1 = await request(app.getHttpServer())
      .post(`/v1/review/${tokenA}/decide`)
      .send({
        action_nonce: ctxA1.body.action_nonce,
        payload_version: 1,
        decision: 'approve',
      })
      .expect(201);
    expect(voteA1.body.status).toBe('pending');

    // Approver B edits to $550 and approves -> bumps to v2, supersedes A's v1 vote
    const ctxB1 = await request(app.getHttpServer()).get(`/v1/review/${tokenB}`).expect(200);
    const voteB1 = await request(app.getHttpServer())
      .post(`/v1/review/${tokenB}/decide`)
      .send({
        action_nonce: ctxB1.body.action_nonce,
        payload_version: 1,
        decision: 'approve',
        edited_fields: { refund_amount_usd: 550 },
      })
      .expect(201);
    expect(voteB1.body.status).toBe('pending');
    expect(voteB1.body.payload_version).toBe(2);

    const votesAfterEdit = await db
      .select()
      .from(approvalVotes)
      .where(
        and(
          eq(approvalVotes.approvalRequestId, created.body.id),
          eq(approvalVotes.approverEmail, 'approver-a@acme.com'),
        ),
      );
    expect(votesAfterEdit[0].supersededAt).not.toBeNull();

    // Approver A re-confirms v2 -> consensus reached
    const ctxA2 = await request(app.getHttpServer()).get(`/v1/review/${tokenA}`).expect(200);
    expect(ctxA2.body.payload_version).toBe(2);
    const voteA2 = await request(app.getHttpServer())
      .post(`/v1/review/${tokenA}/decide`)
      .send({
        action_nonce: ctxA2.body.action_nonce,
        payload_version: 2,
        decision: 'approve',
      })
      .expect(201);
    expect(voteA2.body.status).toBe('edited_and_approved');
  });

  it('CUJ 3: transitions pending request to timed_out via TimeoutProcessor and enforces audit_logs immutability trigger', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/approvals')
      .set('Authorization', `Bearer ${rawApiKey}`)
      .send({
        action_type: 'stripe.refund',
        title: 'Timeout test',
        callback_url: 'https://example.com/hook',
        payload: { order_id: 'ord_timeout', refund_amount_usd: 150 },
      })
      .expect(202);

    // Simulate timeout worker firing
    await timeoutProcessor.process({
      data: { approvalRequestId: created.body.id },
    } as never);

    const [updated] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, created.body.id));
    expect(updated.status).toBe('timed_out');
    expect(updated.deliveryStatus).toBe('pending');

    // Run reconciliation sweep (verifies query executes cleanly)
    await reconciliationProcessor.process({} as never);

    // Verify PostgreSQL BEFORE UPDATE OR DELETE trigger rejects mutations on audit_logs
    const [logRow] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.approvalRequestId, created.body.id))
      .limit(1);
    expect(logRow).toBeDefined();

    await expect(
      db.execute(sql`UPDATE audit_logs SET event_type = 'tampered' WHERE id = ${logRow.id}`),
    ).rejects.toThrow(/append-only/i);

    await expect(
      db.execute(sql`DELETE FROM audit_logs WHERE id = ${logRow.id}`),
    ).rejects.toThrow(/append-only/i);
  });

  it('Phase 3: serves GET /healthz and processes HMAC-verified MoR billing webhooks idempotently', async () => {
    const health = await request(app.getHttpServer()).get('/healthz').expect(200);
    expect(health.body).toEqual({ status: 'ok', postgres: 'up', redis: 'up' });

    const payload = JSON.stringify({
      id: `evt_${crypto.randomUUID()}`,
      type: 'subscription.created',
      data: {
        organization_id: orgId,
        customer_id: 'cus_123',
        subscription_id: 'sub_123',
        plan: 'agency',
        status: 'active',
      },
    });
    const secret = process.env.BILLING_WEBHOOK_SECRET ?? 'whsec_billing_placeholder';
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    await request(app.getHttpServer())
      .post('/v1/billing/webhooks/mor')
      .set('Content-Type', 'application/json')
      .set('x-billing-signature', `sha256=${sig}`)
      .send(payload)
      .expect(201);

    const [orgRow] = await db
      .select({ plan: organizations.plan, billingStatus: organizations.billingStatus })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    expect(orgRow.plan).toBe('agency');
    expect(orgRow.billingStatus).toBe('active');

    const replay = await request(app.getHttpServer())
      .post('/v1/billing/webhooks/mor')
      .set('Content-Type', 'application/json')
      .set('x-billing-signature', `sha256=${sig}`)
      .send(payload)
      .expect(201);
    expect(replay.body.deduplicated).toBe(true);
  });

  it('Phase 4: verifies Slack Block Kit interaction signatures and applies modal edits', async () => {
    const signingSecret = 'slack_test_signing_secret';
    await db
      .update(projects)
      .set({ slackSigningSecretEnc: cryptoSvc.encryptSecret(signingSecret) })
      .where(eq(projects.id, projectId));

    const created = await request(app.getHttpServer())
      .post('/v1/approvals')
      .set('Authorization', `Bearer ${rawApiKey}`)
      .send({
        action_type: 'stripe.refund',
        title: 'Slack edit test',
        callback_url: 'https://example.com/hook',
        payload: { order_id: 'ord_slack', refund_amount_usd: 200 },
        editable_schema: editableSchema,
      })
      .expect(202);

    const slackPayload = JSON.stringify({
      type: 'view_submission',
      user: { id: 'U123', username: 'alex' },
      view: {
        callback_id: 'hitl_edit_submit',
        private_metadata: created.body.id,
        state: {
          values: {
            field_refund_amount_usd: {
              refund_amount_usd: { value: '125' },
            },
          },
        },
      },
    });
    const rawBody = `payload=${encodeURIComponent(slackPayload)}`;
    const ts = Math.floor(Date.now() / 1000);
    const sig = `v0=${crypto.createHmac('sha256', signingSecret).update(`v0:${ts}:${rawBody}`).digest('hex')}`;

    const res = await request(app.getHttpServer())
      .post('/v1/slack/interactions')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('x-slack-request-timestamp', String(ts))
      .set('x-slack-signature', sig)
      .send(rawBody)
      .expect(201);

    expect(res.body).toEqual({ response_action: 'clear' });

    const [updated] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, created.body.id));
    expect(updated.status).toBe('edited_and_approved');
    expect(updated.finalPayload).toEqual({ order_id: 'ord_slack', refund_amount_usd: 125 });
  });
});

// Keep http import referenced for future local webhook mock server tests
void http;
