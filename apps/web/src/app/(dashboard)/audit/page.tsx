'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api-client';

interface AuditRow {
  id: string;
  approvalRequestId: string;
  eventType: string;
  actorType: string;
  actorIdentifier: string;
  diffPayload: unknown;
  createdAt: string;
}

export default function AuditPage() {
  const [projectId, setProjectId] = useState('');
  const [query, setQuery] = useState('');
  const [logs, setLogs] = useState<AuditRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const data = await apiFetch<AuditRow[]>(
        `/dashboard/audit?projectId=${encodeURIComponent(projectId)}`,
      );
      setLogs(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit logs');
    }
  }

  const filtered = query.trim()
    ? logs.filter(
        (l) =>
          l.eventType.includes(query) ||
          l.actorIdentifier.includes(query) ||
          l.approvalRequestId.includes(query),
      )
    : logs;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">Audit Logs</h1>
      <form onSubmit={load} className="flex flex-wrap gap-3">
        <input
          type="text"
          required
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          placeholder="Project UUID"
          className="w-80 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by event, actor, or request ID"
          className="w-64 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white"
        >
          Load Audit Logs
        </button>
        {projectId && (
          <a
            href={`/api/v1/dashboard/audit/export?projectId=${encodeURIComponent(projectId)}`}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700"
          >
            Export CSV
          </a>
        )}
      </form>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">Timestamp</th>
              <th className="px-4 py-3">Event</th>
              <th className="px-4 py-3">Actor</th>
              <th className="px-4 py-3">Request ID</th>
              <th className="px-4 py-3">Diff</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {filtered.map((row) => (
              <tr key={row.id}>
                <td className="px-4 py-3 font-mono text-xs text-slate-500">
                  {new Date(row.createdAt).toLocaleString()}
                </td>
                <td className="px-4 py-3 font-mono text-xs font-medium">{row.eventType}</td>
                <td className="px-4 py-3 text-xs">
                  {row.actorType}: {row.actorIdentifier}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-slate-500">
                  {row.approvalRequestId}
                </td>
                <td className="max-w-xs truncate px-4 py-3 font-mono text-xs text-slate-500">
                  {row.diffPayload ? JSON.stringify(row.diffPayload) : '-'}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                  No audit events loaded.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
