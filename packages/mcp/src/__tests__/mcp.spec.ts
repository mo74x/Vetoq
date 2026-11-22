import { describe, expect, it, vi } from 'vitest';
import type { AgentGate } from '@hitl/sdk';
import { wrapToolWithApproval } from '../index.js';

describe('@hitl/mcp', () => {
  it('executes handler with edited finalPayload when approved', async () => {
    const mockGate = {
      requestAndWait: vi.fn().mockResolvedValue({
        id: 'req_1',
        status: 'edited_and_approved',
        isApproved: true,
        originalPayload: { amount: 240 },
        finalPayload: { amount: 120 },
      }),
    } as unknown as AgentGate;

    const handler = vi.fn(async (args: { amount: number }) => ({ ok: true, charged: args.amount }));
    const wrapped = wrapToolWithApproval(handler, {
      gate: mockGate,
      actionType: 'stripe.refund',
      title: 'Refund',
    });

    const result = await wrapped({ amount: 240 });
    expect(handler).toHaveBeenCalledWith({ amount: 120 });
    expect(result).toEqual({ ok: true, charged: 120 });
  });

  it('blocks handler execution when rejected', async () => {
    const mockGate = {
      requestAndWait: vi.fn().mockResolvedValue({
        id: 'req_2',
        status: 'rejected',
        isApproved: false,
        originalPayload: { amount: 240 },
        finalPayload: { amount: 240 },
      }),
    } as unknown as AgentGate;

    const handler = vi.fn();
    const wrapped = wrapToolWithApproval(handler, {
      gate: mockGate,
      actionType: 'stripe.refund',
      title: 'Refund',
    });

    const result = await wrapped({ amount: 240 });
    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({ blocked: true, status: 'rejected', requestId: 'req_2' });
  });
});
