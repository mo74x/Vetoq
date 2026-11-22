'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { ProjectSelector } from '@/components/dashboard/project-selector';

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
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(e?: React.FormEvent) {
    e?.preventDefault();
    if (!projectId) return;
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

  useEffect(() => {
    if (projectId) void load();
  }, [projectId]);

  async function retryDelivery(deliveryId: string) {
    setRetryingId(deliveryId);
    setError(null);
    try {
      await apiFetch(`/dashboard/approvals/webhooks/${deliveryId}/retry`, {
        method: 'POST',
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">Webhook Deliveries</h1>
      <form onSubmit={load} className="flex gap-3">
        <ProjectSelector value={projectId} onChange={setProjectId} />
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white"
        >
          Refresh
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
              <th className="px-4 py-3">Action</th>
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
                <td className="px-4 py-3 text-xs">
                  {d.status === 'failed' ? (
                    <button
                      type="button"
                      disabled={retryingId === d.id}
                      onClick={() => retryDelivery(d.id)}
                      className="rounded border border-slate-300 px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {retryingId === d.id ? 'Queuing...' : 'Retry Now'}
                    </button>
                  ) : (
                    '-'
                  )}
                </td>
              </tr>
            ))}
            {deliveries.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
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
