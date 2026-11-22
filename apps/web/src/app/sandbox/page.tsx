'use client';

import { useState } from 'react';
import Link from 'next/link';
import { applyAndValidateEdits, evaluatePolicies, type EditableSchemaMap, type PolicyRule } from '@hitl/shared';

const DEMO_POLICIES: PolicyRule[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    action_type: 'stripe.refund',
    priority: 10,
    conditions: [{ field: 'refund_amount_usd', op: 'lte', value: 50 }],
    decision_mode: 'auto_approve',
    required_approvals: 1,
    timeout_seconds: 1800,
    timeout_behavior: 'reject',
    require_otp: false,
    approver_emails: ['finance@acme.com'],
    is_active: true,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    action_type: 'stripe.refund',
    priority: 20,
    conditions: [{ field: 'refund_amount_usd', op: 'gt', value: 50 }],
    decision_mode: 'require_approval',
    required_approvals: 1,
    timeout_seconds: 1800,
    timeout_behavior: 'reject',
    require_otp: false,
    approver_emails: ['finance@acme.com'],
    is_active: true,
  },
];

const DEMO_SCHEMA: EditableSchemaMap = {
  refund_amount_usd: {
    type: 'number',
    label: 'Refund Amount (USD)',
    editable: true,
    min: 0,
    max: 500,
  },
  reply_message: {
    type: 'textarea',
    label: 'Customer Reply',
    editable: true,
    maxLength: 500,
  },
  order_id: {
    type: 'string',
    label: 'Order ID',
    editable: false,
  },
};

const ORIGINAL_PAYLOAD = {
  order_id: 'ord_98421',
  refund_amount_usd: 240,
  reply_message: 'Hi Sarah, we have issued a full refund of $240 for your order.',
};

export default function SandboxPage() {
  const [amount, setAmount] = useState(240);
  const [reply, setReply] = useState(ORIGINAL_PAYLOAD.reply_message);
  const [decision, setDecision] = useState<'pending' | 'approved' | 'edited_and_approved' | 'rejected'>('pending');

  const evaluation = evaluatePolicies('stripe.refund', ORIGINAL_PAYLOAD, DEMO_POLICIES);
  const editCheck = applyAndValidateEdits(
    ORIGINAL_PAYLOAD,
    { refund_amount_usd: amount, reply_message: reply },
    DEMO_SCHEMA,
  );

  const webhookPreview =
    decision === 'pending'
      ? null
      : {
          event:
            decision === 'rejected'
              ? 'approval.rejected'
              : decision === 'edited_and_approved'
                ? 'approval.edited_and_approved'
                : 'approval.approved',
          request_id: 'req_sandbox_01j9x8k2',
          action_type: 'stripe.refund',
          status: decision,
          original_payload: ORIGINAL_PAYLOAD,
          final_payload: editCheck.valid ? editCheck.finalPayload : ORIGINAL_PAYLOAD,
          diff: editCheck.diff,
        };

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Interactive Sandbox (No Signup)
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">
            Edit-Before-Execute Simulator
          </h1>
        </div>
        <Link href="/" className="text-sm text-slate-600 underline">
          Back Home
        </Link>
      </div>

      <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <strong>Policy Matched:</strong> AI agent proposed <code>$240</code> refund → triggered{' '}
        <code>{evaluation.decision_mode}</code> (exceeds <code>&lt;= $50</code> auto-approve rule).
      </div>

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="text-base font-semibold text-slate-900">Magic-Link Review Portal</h2>
          <div>
            <label className="block text-xs font-medium text-slate-600">
              Order ID <span className="text-slate-400">(read-only)</span>
            </label>
            <input
              type="text"
              disabled
              value={ORIGINAL_PAYLOAD.order_id}
              className="mt-1 w-full rounded-md border border-slate-300 bg-slate-100 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600">
              Refund Amount (USD) — max $500
            </label>
            <input
              type="number"
              value={amount}
              onChange={(e) => {
                setAmount(Number(e.target.value));
                setDecision('pending');
              }}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600">Customer Reply</label>
            <textarea
              rows={3}
              value={reply}
              onChange={(e) => {
                setReply(e.target.value);
                setDecision('pending');
              }}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          {!editCheck.valid && (
            <p className="text-xs text-red-600">{editCheck.errors.join(' ')}</p>
          )}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              disabled={!editCheck.valid}
              onClick={() =>
                setDecision(editCheck.changed ? 'edited_and_approved' : 'approved')
              }
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {editCheck.changed ? 'Approve with Edits' : 'Approve & Resume'}
            </button>
            <button
              type="button"
              onClick={() => setDecision('rejected')}
              className="rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700"
            >
              Reject
            </button>
          </div>
        </div>

        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="text-base font-semibold text-slate-900">
            Live RFC 6902 Diff &amp; Signed Webhook
          </h2>
          <div>
            <p className="text-xs font-medium text-slate-500">Server-Computed JSON Diff</p>
            <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-3 text-xs">
              {JSON.stringify(editCheck.diff, null, 2)}
            </pre>
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500">
              Webhook Callback (X-Signature-256)
            </p>
            <pre className="mt-1 overflow-x-auto rounded bg-slate-900 p-3 text-xs text-emerald-300">
              {webhookPreview
                ? JSON.stringify(webhookPreview, null, 2)
                : '// Click Approve or Reject to inspect resumed webhook payload'}
            </pre>
          </div>
        </div>
      </div>
    </main>
  );
}
