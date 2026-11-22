'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { ProjectSelector } from '@/components/dashboard/project-selector';

interface ApprovalItem {
  id: string;
  actionType: string;
  title: string;
  status: string;
  deliveryStatus: string;
  payloadVersion: number;
  originalPayload: Record<string, unknown>;
  finalPayload: Record<string, unknown> | null;
  createdAt: string;
}

export default function QueuePage() {
  const [projectId, setProjectId] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [selected, setSelected] = useState<ApprovalItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(e?: React.FormEvent) {
    e?.preventDefault();
    if (!projectId) return;
    setError(null);
    try {
      const data = await apiFetch<ApprovalItem[]>(
        `/dashboard/approvals?projectId=${encodeURIComponent(projectId)}`,
      );
      setItems(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load queue');
    }
  }

  useEffect(() => {
    if (projectId) void load();
  }, [projectId]);

  const filtered =
    statusFilter === 'all' ? items : items.filter((item) => item.status === statusFilter);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">Approval Queue</h1>
      <form onSubmit={load} className="flex flex-wrap gap-3">
        <ProjectSelector value={projectId} onChange={setProjectId} />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="all">All statuses</option>
          <option value="pending">pending</option>
          <option value="approved">approved</option>
          <option value="edited_and_approved">edited_and_approved</option>
          <option value="rejected">rejected</option>
          <option value="timed_out">timed_out</option>
          <option value="auto_approved">auto_approved</option>
          <option value="auto_rejected">auto_rejected</option>
        </select>
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white"
        >
          Load Approvals
        </button>
      </form>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">Title</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Webhook</th>
              <th className="px-4 py-3">Version</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {filtered.map((item) => (
              <tr
                key={item.id}
                onClick={() => setSelected(item)}
                className="cursor-pointer hover:bg-slate-50"
              >
                <td className="px-4 py-3 font-medium text-slate-900">{item.title}</td>
                <td className="px-4 py-3 font-mono text-xs text-slate-600">{item.actionType}</td>
                <td className="px-4 py-3 font-mono text-xs">{item.status}</td>
                <td className="px-4 py-3 font-mono text-xs">{item.deliveryStatus}</td>
                <td className="px-4 py-3 text-xs">v{item.payloadVersion}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                  No approval requests found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="grid gap-4 rounded-lg border border-slate-200 bg-white p-6 md:grid-cols-2">
          <div>
            <h3 className="text-xs font-semibold uppercase text-slate-500">Original Payload</h3>
            <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-3 text-xs">
              {JSON.stringify(selected.originalPayload, null, 2)}
            </pre>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase text-slate-500">Final Payload</h3>
            <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-3 text-xs">
              {JSON.stringify(selected.finalPayload ?? selected.originalPayload, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
