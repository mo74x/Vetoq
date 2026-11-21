import { describe, expect, it } from 'vitest';
import { evaluatePolicies } from '../policy-evaluator.js';
import type { PolicyRule } from '../schemas.js';

const basePolicy: PolicyRule = {
  id: '11111111-1111-4111-8111-111111111111',
  action_type: 'stripe.refund',
  priority: 10,
  conditions: [{ field: 'refund_amount_usd', op: 'lte', value: 50 }],
  decision_mode: 'auto_approve',
  required_approvals: 1,
  timeout_seconds: 3600,
  timeout_behavior: 'reject',
  approver_emails: ['lead@agency.com'],
  is_active: true,
};

describe('evaluatePolicies', () => {
  it('matches highest priority policy first', () => {
    const highRisk: PolicyRule = {
      ...basePolicy,
      id: '22222222-2222-4222-8222-222222222222',
      priority: 20,
      conditions: [{ field: 'refund_amount_usd', op: 'gt', value: 50 }],
      decision_mode: 'require_approval',
      required_approvals: 2,
    };
    const result = evaluatePolicies('stripe.refund', { refund_amount_usd: 25 }, [highRisk, basePolicy]);
    expect(result.decision_mode).toBe('auto_approve');
    expect(result.matched_policy_id).toBe(basePolicy.id);
  });

  it('fails closed when no policy matches', () => {
    const result = evaluatePolicies('email.send', { to: 'a@b.com' }, [basePolicy]);
    expect(result.decision_mode).toBe('require_approval');
    expect(result.required_approvals).toBe(1);
    expect(result.fallback_reason).toBe('no_matching_policy');
  });

  it('fails closed when condition field is missing or type mismatches', () => {
    const result = evaluatePolicies('stripe.refund', { refund_amount_usd: '25' }, [basePolicy]);
    expect(result.decision_mode).toBe('require_approval');
    expect(result.fallback_reason).toBe('condition_parse_error');
  });

  it('blocks prototype pollution in dot-path resolution', () => {
    const protoPolicy: PolicyRule = {
      ...basePolicy,
      conditions: [{ field: '__proto__.polluted', op: 'eq', value: true }],
    };
    const result = evaluatePolicies('stripe.refund', {}, [protoPolicy]);
    expect(result.decision_mode).toBe('require_approval');
    expect(result.fallback_reason).toBe('condition_parse_error');
  });
});
