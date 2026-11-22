import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AgentGate, verifyWebhookSignature } from '../index.js';

describe('@hitl/sdk', () => {
  it('verifies HMAC-SHA256 webhook signatures within timestamp window', () => {
    const secret = 'whsec_test_123';
    const body = JSON.stringify({ event: 'approval.approved' });
    const ts = Math.floor(Date.now() / 1000);
    const sig = `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;

    expect(verifyWebhookSignature(body, String(ts), sig, secret)).toBe(true);
    expect(verifyWebhookSignature(body, String(ts), 'sha256=bad', secret)).toBe(false);
    expect(verifyWebhookSignature(body, String(ts - 1000), sig, secret, 300)).toBe(false);
  });

  it('requestAndWait polls until edited_and_approved and returns finalPayload', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'req_1', status: 'pending' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'req_1',
          status: 'edited_and_approved',
          originalPayload: { amount: 240 },
          finalPayload: { amount: 120 },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const gate = new AgentGate({ apiKey: 'hk_live_test', baseUrl: 'http://localhost:3001' });
    const decision = await gate.requestAndWait({
      actionType: 'stripe.refund',
      title: 'Refund',
      payload: { amount: 240 },
      pollIntervalMs: 1,
      timeoutMs: 1000,
    });

    expect(decision.isApproved).toBe(true);
    expect(decision.status).toBe('edited_and_approved');
    expect(decision.finalPayload).toEqual({ amount: 120 });
    vi.unstubAllGlobals();
  });
});
