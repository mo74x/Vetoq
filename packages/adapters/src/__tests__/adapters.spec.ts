import { describe, expect, it, vi } from 'vitest';
import type { AgentGate } from '@hitl/sdk';
import { createLangGraphApprovalNode, withVetoqVercelTool } from '../index.js';

describe('@hitl/adapters', () => {
  it('withVetoqVercelTool executes with edited finalPayload when approved', async () => {
    const mockGate = {
      requestAndWait: vi.fn().mockResolvedValue({
        id: 'req_1',
        status: 'edited_and_approved',
        isApproved: true,
        originalPayload: { amount: 200 },
        finalPayload: { amount: 100 },
      }),
    } as unknown as AgentGate;

    const execute = vi.fn(async (args: { amount: number }) => ({ refunded: args.amount }));
    const wrapped = withVetoqVercelTool(
      { description: 'Refund', execute },
      { gate: mockGate, actionType: 'stripe.refund', title: 'Refund' },
    );

    const res = await wrapped.execute({ amount: 200 });
    expect(execute).toHaveBeenCalledWith({ amount: 100 });
    expect(res).toEqual({ refunded: 100 });
  });

  it('createLangGraphApprovalNode returns decision and approvedPayload', async () => {
    const mockGate = {
      requestAndWait: vi.fn().mockResolvedValue({
        id: 'req_2',
        status: 'approved',
        isApproved: true,
        originalPayload: { to: 'cto@acme.com' },
        finalPayload: { to: 'cto@acme.com' },
      }),
    } as unknown as AgentGate;

    const node = createLangGraphApprovalNode<{ email: { to: string } }>({
      gate: mockGate,
      actionType: 'email.send',
      title: 'Send email',
      getPayload: (s) => s.email,
    });

    const out = await node({ email: { to: 'cto@acme.com' } });
    expect(out.vetoqDecision.isApproved).toBe(true);
    expect(out.approvedPayload).toEqual({ to: 'cto@acme.com' });
  });
});
