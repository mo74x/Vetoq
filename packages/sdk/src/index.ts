import crypto from 'node:crypto';
import type { EditableSchemaMap } from '@hitl/shared';

export interface AgentGateOptions {
  apiKey: string;
  baseUrl?: string;
}

export interface RequestApprovalInput {
  actionType: string;
  title: string;
  summary?: string;
  agentName?: string;
  payload: Record<string, unknown>;
  callbackUrl: string;
  timeoutSeconds?: number;
  editableSchema?: EditableSchemaMap;
  idempotencyKey?: string;
}

export interface RequestAndWaitInput extends Omit<RequestApprovalInput, 'callbackUrl'> {
  callbackUrl?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ApprovalDecision<T = Record<string, unknown>> {
  id: string;
  status: string;
  isApproved: boolean;
  originalPayload: T;
  finalPayload: T;
}

const TERMINAL_STATUSES = new Set([
  'approved',
  'edited_and_approved',
  'rejected',
  'timed_out',
  'auto_approved',
  'auto_rejected',
]);

export class AgentGate {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: AgentGateOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'http://localhost:3001').replace(/\/$/, '');
  }

  async requestApproval(input: RequestApprovalInput) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (input.idempotencyKey) {
      headers['Idempotency-Key'] = input.idempotencyKey;
    }

    const res = await fetch(`${this.baseUrl}/v1/approvals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        action_type: input.actionType,
        title: input.title,
        summary: input.summary,
        agent_name: input.agentName,
        callback_url: input.callbackUrl,
        timeout_seconds: input.timeoutSeconds,
        payload: input.payload,
        editable_schema: input.editableSchema,
      }),
    });

    if (!res.ok) {
      throw new Error(`HITL API error (${res.status}): ${await res.text()}`);
    }

    return res.json() as Promise<{
      id: string;
      status: string;
      expires_at?: string;
      final_payload?: Record<string, unknown>;
    }>;
  }

  async getApproval(id: string) {
    const res = await fetch(`${this.baseUrl}/v1/approvals/${encodeURIComponent(id)}`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });
    if (!res.ok) {
      throw new Error(`HITL API error (${res.status}): ${await res.text()}`);
    }
    return res.json() as Promise<{
      id: string;
      status: string;
      originalPayload: Record<string, unknown>;
      finalPayload: Record<string, unknown> | null;
    }>;
  }

  async requestAndWait<T extends Record<string, unknown> = Record<string, unknown>>(
    input: RequestAndWaitInput,
  ): Promise<ApprovalDecision<T>> {
    const timeoutMs = input.timeoutMs ?? 15 * 60 * 1000;
    const pollIntervalMs = input.pollIntervalMs ?? 2000;

    const created = await this.requestApproval({
      ...input,
      callbackUrl: input.callbackUrl ?? 'https://example.invalid/hitl-polling',
      timeoutSeconds: input.timeoutSeconds ?? Math.max(60, Math.ceil(timeoutMs / 1000)),
    });

    if (TERMINAL_STATUSES.has(created.status)) {
      return {
        id: created.id,
        status: created.status,
        isApproved: created.status === 'auto_approved' || created.status === 'approved',
        originalPayload: input.payload as T,
        finalPayload: (created.final_payload ?? input.payload) as T,
      };
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      const row = await this.getApproval(created.id);
      if (TERMINAL_STATUSES.has(row.status)) {
        return {
          id: row.id,
          status: row.status,
          isApproved:
            row.status === 'approved' ||
            row.status === 'edited_and_approved' ||
            row.status === 'auto_approved',
          originalPayload: row.originalPayload as T,
          finalPayload: (row.finalPayload ?? row.originalPayload) as T,
        };
      }
    }

    return {
      id: created.id,
      status: 'timed_out',
      isApproved: false,
      originalPayload: input.payload as T,
      finalPayload: input.payload as T,
    };
  }
}

export function verifyWebhookSignature(
  rawBody: string | Buffer,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  secret: string,
  toleranceSeconds = 300,
): boolean {
  const ts = Number(timestampHeader);
  if (!ts || Math.abs(Math.floor(Date.now() / 1000) - ts) > toleranceSeconds) {
    return false;
  }
  if (!signatureHeader) return false;
  const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${bodyStr}`).digest('hex')}`;
  const a = Buffer.from(signatureHeader, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
