'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api-client';

interface WebhookRow {
  id: string;
  approvalRequestId: string;
  callbackUrl: string;
  attemptNumber: number;
  httpStatus: number | null;
  responseBody: string | null;
  status: string;
  createdAt: string;
}

export default function WebhooksPage() {
  const [projectId, setProjectId] = useState('');
  const [deliveries, setDeliveries] = useState<WebhookRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const data = await apiFetch<WebhookRow[]>(
        `/dashboard/approvals/webhooks?projectId=${encodeURIComponent(projectId)}`,
      );
      setDeliveries(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load webhook deliveries');
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">Webhook Deliveries</h1>
      <form onSubmit={load} className="flex gap-3">
        <input
          type="text"
          required
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          placeholder="Project UUID"
          className="w-80 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white"
        >
          Load Deliveries
        </button>
      </form>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">HTTP</th>
              <th className="px-4 py-3">Attempt</th>
              <th className="px-4 py-3">Callback URL</th>
              <th className="px-4 py-3">Response</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {deliveries.map((d) => (
              <tr key={d.id}>
                <td className="px-4 py-3 font-mono text-xs">{d.status}</td>
                <td className="px-4 py-3 font-mono text-xs">{d.httpStatus ?? '-'}</td>
                <td className="px-4 py-3 text-xs">{d.attemptNumber}</td>
                <td className="max-w-xs truncate px-4 py-3 font-mono text-xs text-slate-600">
                  {d.callbackUrl}
                </td>
                <td className="max-w-xs truncate px-4 py-3 font-mono text-xs text-slate-500">
                  {d.responseBody ?? '-'}
                </td>
              </tr>
            ))}
            {deliveries.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                  No webhook deliveries loaded.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
