'use client';

import { useState } from 'react';
import type { EditableSchemaMap } from '@hitl/shared';

interface EditableFormProps {
  token: string;
  actionNonce: string;
  payloadVersion: number;
  requireOtp?: boolean;
  originalPayload: Record<string, unknown>;
  currentPayload: Record<string, unknown>;
  editableSchema: EditableSchemaMap | null;
  accentColor?: string;
}

export function EditableForm({
  token,
  actionNonce,
  payloadVersion,
  requireOtp = false,
  originalPayload,
  currentPayload,
  editableSchema,
  accentColor = '#0f172a',
}: EditableFormProps) {
  const [formValues, setFormValues] = useState<Record<string, unknown>>({ ...currentPayload });
  const [approverName, setApproverName] = useState('');
  const [note, setNote] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resultStatus, setResultStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const schemaEntries = editableSchema ? Object.entries(editableSchema) : [];

  function computeEditedFields(): Record<string, unknown> {
    const edited: Record<string, unknown> = {};
    for (const [key, field] of schemaEntries) {
      if (!field.editable) continue;
      if (formValues[key] !== currentPayload[key]) {
        edited[key] = formValues[key];
      }
    }
    return edited;
  }

  async function submitDecision(decision: 'approve' | 'reject') {
    setSubmitting(true);
    setError(null);
    try {
      const editedFields = decision === 'approve' ? computeEditedFields() : undefined;
      const res = await fetch(`/api/v1/review/${encodeURIComponent(token)}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action_nonce: actionNonce,
          payload_version: payloadVersion,
          decision,
          approver_name: approverName.trim() || undefined,
          otp_code: requireOtp && otpCode.trim() ? otpCode.trim() : undefined,
          edited_fields:
            editedFields && Object.keys(editedFields).length > 0 ? editedFields : undefined,
          note: note.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Failed with HTTP ${res.status}`);
      }
      const data = (await res.json()) as { status: string };
      setResultStatus(data.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (resultStatus) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-6">
        <h2 className="text-lg font-semibold text-emerald-900">Decision Recorded</h2>
        <p className="mt-1 text-sm text-emerald-800">
          Current request status: <code className="font-mono">{resultStatus}</code>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {schemaEntries.length > 0 ? (
        <div className="space-y-4">
          {schemaEntries.map(([key, field]) => {
            const val = formValues[key];
            return (
              <div key={key}>
                <label className="block text-sm font-medium text-slate-700">
                  {field.label}{' '}
                  {!field.editable && (
                    <span className="ml-1 text-xs font-normal text-slate-400">(read-only)</span>
                  )}
                </label>
                {field.type === 'textarea' ? (
                  <textarea
                    rows={3}
                    disabled={!field.editable}
                    maxLength={field.maxLength}
                    value={String(val ?? '')}
                    onChange={(e) => setFormValues({ ...formValues, [key]: e.target.value })}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
                  />
                ) : field.type === 'number' ? (
                  <input
                    type="number"
                    disabled={!field.editable}
                    min={field.min}
                    max={field.max}
                    step="any"
                    value={typeof val === 'number' ? val : ''}
                    onChange={(e) =>
                      setFormValues({ ...formValues, [key]: Number(e.target.value) })
                    }
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
                  />
                ) : field.type === 'boolean' ? (
                  <input
                    type="checkbox"
                    disabled={!field.editable}
                    checked={Boolean(val)}
                    onChange={(e) => setFormValues({ ...formValues, [key]: e.target.checked })}
                    className="mt-2 h-4 w-4"
                  />
                ) : field.type === 'enum' ? (
                  <select
                    disabled={!field.editable}
                    value={String(val ?? '')}
                    onChange={(e) => setFormValues({ ...formValues, [key]: e.target.value })}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
                  >
                    {field.options.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    disabled={!field.editable}
                    maxLength={field.maxLength}
                    value={String(val ?? '')}
                    onChange={(e) => setFormValues({ ...formValues, [key]: e.target.value })}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
                  />
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <pre className="overflow-x-auto rounded-md bg-slate-100 p-4 text-xs text-slate-800">
          {JSON.stringify(originalPayload, null, 2)}
        </pre>
      )}

      <div className="grid gap-4 border-t border-slate-200 pt-4 sm:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-slate-700">Your Name (optional)</label>
          <input
            type="text"
            value={approverName}
            onChange={(e) => setApproverName(e.target.value)}
            placeholder="Alex Rivera"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700">
            Decision Note (optional)
          </label>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Reason or context"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {requireOtp && (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-slate-700">
              6-Digit Email Verification Required
            </p>
            <button
              type="button"
              onClick={async () => {
                setError(null);
                const r = await fetch(`/api/v1/review/${encodeURIComponent(token)}/otp`, {
                  method: 'POST',
                });
                if (r.ok) setOtpSent(true);
                else setError('Failed to send OTP code');
              }}
              className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700"
            >
              {otpSent ? 'Resend Code' : 'Send Code'}
            </button>
          </div>
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={otpCode}
            onChange={(e) => setOtpCode(e.target.value)}
            placeholder="Enter 6-digit OTP"
            className="mt-2 w-48 rounded-md border border-slate-300 bg-white px-3 py-1.5 font-mono text-sm"
          />
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={submitting}
          onClick={() => submitDecision('approve')}
          style={{ backgroundColor: accentColor }}
          className="rounded-md px-5 py-2.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {Object.keys(computeEditedFields()).length > 0
            ? 'Approve with Edits'
            : 'Approve & Resume'}
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={() => submitDecision('reject')}
          className="rounded-md border border-red-300 bg-white px-5 py-2.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
        >
          Reject
        </button>
      </div>
    </div>
  );
}
