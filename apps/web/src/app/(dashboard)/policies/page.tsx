'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { ProjectSelector } from '@/components/dashboard/project-selector';

interface ConditionRow {
  field: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains';
  value: string;
}

interface PolicyRow {
  id: string;
  actionType: string;
  priority: number;
  conditions: Array<{ field: string; op: string; value: unknown }>;
  decisionMode: string;
  requiredApprovals: number;
  timeoutSeconds: number;
  approverEmails: string[];
}

export default function PoliciesPage() {
  const [projectId, setProjectId] = useState('');
  const [policies, setPolicies] = useState<PolicyRow[]>([]);
  const [actionType, setActionType] = useState('stripe.refund');
  const [priority, setPriority] = useState(50);
  const [decisionMode, setDecisionMode] = useState<'auto_approve' | 'require_approval' | 'auto_reject'>('require_approval');
  const [requiredApprovals, setRequiredApprovals] = useState(1);
  const [timeoutSeconds, setTimeoutSeconds] = useState(1800);
  const [approverEmails, setApproverEmails] = useState('');
  const [conditions, setConditions] = useState<ConditionRow[]>([
    { field: 'refund_amount_usd', op: 'gt', value: '50' },
  ]);
  const [error, setError] = useState<string | null>(null);

  async function loadPolicies() {
    if (!projectId) return;
    setError(null);
    try {
      const data = await apiFetch<PolicyRow[]>(
        `/dashboard/policies?projectId=${encodeURIComponent(projectId)}`,
      );
      setPolicies(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load policies');
    }
  }

  useEffect(() => {
    if (projectId) void loadPolicies();
  }, [projectId]);

  function parseConditionValue(raw: string, op: string): unknown {
    if (op === 'in') {
      return raw.split(',').map((s) => s.trim());
    }
    const num = Number(raw);
    if (raw.trim() !== '' && !Number.isNaN(num)) return num;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return raw;
  }

  async function createPolicy(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) return;
    setError(null);
    try {
      await apiFetch('/dashboard/policies', {
        method: 'POST',
        body: JSON.stringify({
          projectId,
          action_type: actionType,
          priority: Number(priority),
          conditions: conditions
            .filter((c) => c.field.trim())
            .map((c) => ({
              field: c.field.trim(),
              op: c.op,
              value: parseConditionValue(c.value, c.op),
            })),
          decision_mode: decisionMode,
          required_approvals: Number(requiredApprovals),
          timeout_seconds: Number(timeoutSeconds),
          approver_emails: approverEmails
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      });
      await loadPolicies();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create policy');
    }
  }

  async function deletePolicy(id: string) {
    if (!projectId) return;
    setError(null);
    try {
      await apiFetch(`/dashboard/policies/${id}?projectId=${encodeURIComponent(projectId)}`, {
        method: 'DELETE',
      });
      await loadPolicies();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete policy');
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">Policy Rules</h1>
      <div className="flex gap-3">
        <ProjectSelector value={projectId} onChange={setProjectId} />
        <button
          type="button"
          onClick={loadPolicies}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white"
        >
          Refresh
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {projectId && (
        <form onSubmit={createPolicy} className="space-y-4 rounded-lg border border-slate-200 bg-white p-6">
          <h2 className="text-base font-semibold text-slate-900">Add Policy Rule</h2>
          <div className="grid gap-4 sm:grid-cols-4">
            <div>
              <label className="block text-xs font-medium text-slate-600">Action Type</label>
              <input
                type="text"
                required
                value={actionType}
                onChange={(e) => setActionType(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">Priority (ASC)</label>
              <input
                type="number"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">Decision Mode</label>
              <select
                value={decisionMode}
                onChange={(e) => setDecisionMode(e.target.value as typeof decisionMode)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              >
                <option value="auto_approve">auto_approve</option>
                <option value="require_approval">require_approval</option>
                <option value="auto_reject">auto_reject</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">Required Approvals</label>
              <input
                type="number"
                min={1}
                value={requiredApprovals}
                onChange={(e) => setRequiredApprovals(Number(e.target.value))}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-slate-600">
                Approver Emails (comma-separated)
              </label>
              <input
                type="text"
                value={approverEmails}
                onChange={(e) => setApproverEmails(e.target.value)}
                placeholder="lead@agency.com, client@acme.com"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">Timeout (seconds)</label>
              <input
                type="number"
                min={60}
                value={timeoutSeconds}
                onChange={(e) => setTimeoutSeconds(Number(e.target.value))}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-slate-600">Conditions (AND-ed)</label>
              <button
                type="button"
                onClick={() =>
                  setConditions([...conditions, { field: '', op: 'eq', value: '' }])
                }
                className="text-xs font-medium text-slate-700 underline"
              >
                + Add Condition
              </button>
            </div>
            {conditions.map((cond, idx) => (
              <div key={idx} className="flex gap-2">
                <input
                  type="text"
                  value={cond.field}
                  onChange={(e) => {
                    const copy = [...conditions];
                    copy[idx].field = e.target.value;
                    setConditions(copy);
                  }}
                  placeholder="field (e.g. refund_amount_usd)"
                  className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                />
                <select
                  value={cond.op}
                  onChange={(e) => {
                    const copy = [...conditions];
                    copy[idx].op = e.target.value as ConditionRow['op'];
                    setConditions(copy);
                  }}
                  className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                >
                  {['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains'].map((op) => (
                    <option key={op} value={op}>
                      {op}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={cond.value}
                  onChange={(e) => {
                    const copy = [...conditions];
                    copy[idx].value = e.target.value;
                    setConditions(copy);
                  }}
                  placeholder="value"
                  className="w-40 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                />
              </div>
            ))}
          </div>

          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white"
          >
            Create Policy
          </button>
        </form>
      )}

      <div className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
        {policies.map((p) => (
          <div key={p.id} className="flex items-center justify-between px-4 py-3 text-sm">
            <div>
              <p className="font-medium text-slate-900">
                [{p.priority}] {p.actionType} → <code className="font-mono">{p.decisionMode}</code>
              </p>
              <p className="text-xs text-slate-500">
                Conditions: {JSON.stringify(p.conditions)} · Required: {p.requiredApprovals} ·
                Approvers: {p.approverEmails.join(', ') || 'fallback'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => deletePolicy(p.id)}
              className="text-xs text-red-600 hover:underline"
            >
              Delete
            </button>
          </div>
        ))}
        {policies.length === 0 && (
          <p className="px-4 py-6 text-sm text-slate-500">No policies loaded.</p>
        )}
      </div>
    </div>
  );
}
