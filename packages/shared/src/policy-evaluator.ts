import { policyConditionSchema, type PolicyCondition, type PolicyRule } from './schemas.js';

const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

export interface PolicyEvaluationResult {
  decision_mode: 'auto_approve' | 'require_approval' | 'auto_reject';
  required_approvals: number;
  timeout_seconds: number;
  timeout_behavior: 'reject';
  require_otp: boolean;
  approver_emails: string[];
  matched_policy_id: string | null;
  matched_policy_snapshot: PolicyRule | null;
  fallback_reason?: 'no_matching_policy' | 'condition_parse_error';
}

export function resolveDotPath(
  payload: Record<string, unknown>,
  path: string,
): { found: boolean; value: unknown } {
  const segments = path.split('.');
  let current: unknown = payload;

  for (const segment of segments) {
    if (!segment || FORBIDDEN_PATH_SEGMENTS.has(segment)) {
      return { found: false, value: undefined };
    }
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return { found: false, value: undefined };
    }
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, segment)) {
      return { found: false, value: undefined };
    }
    current = record[segment];
  }

  return { found: true, value: current };
}

function evaluatePredicate(
  payload: Record<string, unknown>,
  condition: PolicyCondition,
): { matched: boolean; error: boolean } {
  const { found, value: actual } = resolveDotPath(payload, condition.field);
  if (!found) {
    return { matched: false, error: true };
  }

  const expected = condition.value;

  switch (condition.op) {
    case 'eq':
      return { matched: actual === expected, error: false };
    case 'neq':
      return { matched: actual !== expected, error: false };
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (typeof actual !== 'number' || typeof expected !== 'number' || Number.isNaN(actual)) {
        return { matched: false, error: true };
      }
      if (condition.op === 'gt') return { matched: actual > expected, error: false };
      if (condition.op === 'gte') return { matched: actual >= expected, error: false };
      if (condition.op === 'lt') return { matched: actual < expected, error: false };
      return { matched: actual <= expected, error: false };
    }
    case 'in': {
      if (!Array.isArray(expected)) {
        return { matched: false, error: true };
      }
      return { matched: expected.includes(actual), error: false };
    }
    case 'contains': {
      if (typeof actual === 'string' && typeof expected === 'string') {
        return { matched: actual.includes(expected), error: false };
      }
      if (Array.isArray(actual)) {
        return { matched: actual.includes(expected), error: false };
      }
      return { matched: false, error: true };
    }
  }
}

function failClosedResult(
  reason: 'no_matching_policy' | 'condition_parse_error',
  defaultTimeoutSeconds: number,
): PolicyEvaluationResult {
  return {
    decision_mode: 'require_approval',
    required_approvals: 1,
    timeout_seconds: defaultTimeoutSeconds,
    timeout_behavior: 'reject',
    require_otp: false,
    approver_emails: [],
    matched_policy_id: null,
    matched_policy_snapshot: null,
    fallback_reason: reason,
  };
}

/**
 * Evaluates active policies ordered by priority ASC (first match wins).
 * Fails closed to require_approval on missing policies or condition evaluation errors.
 */
export function evaluatePolicies(
  actionType: string,
  payload: Record<string, unknown>,
  policies: PolicyRule[],
  defaultTimeoutSeconds = 3600,
): PolicyEvaluationResult {
  const candidates = policies
    .filter((p) => p.is_active && (p.action_type === actionType || p.action_type === '*'))
    .sort((a, b) => a.priority - b.priority);

  for (const policy of candidates) {
    const parsedConditions = policyConditionSchema.array().safeParse(policy.conditions);
    if (!parsedConditions.success) {
      return failClosedResult('condition_parse_error', defaultTimeoutSeconds);
    }

    let allMatched = true;
    for (const cond of parsedConditions.data) {
      const { matched, error } = evaluatePredicate(payload, cond);
      if (error) {
        return failClosedResult('condition_parse_error', defaultTimeoutSeconds);
      }
      if (!matched) {
        allMatched = false;
        break;
      }
    }

    if (allMatched) {
      return {
        decision_mode: policy.decision_mode,
        required_approvals: policy.required_approvals,
        timeout_seconds: policy.timeout_seconds,
        timeout_behavior: 'reject',
        require_otp: policy.require_otp ?? false,
        approver_emails: policy.approver_emails,
        matched_policy_id: policy.id,
        matched_policy_snapshot: policy,
      };
    }
  }

  return failClosedResult('no_matching_policy', defaultTimeoutSeconds);
}
