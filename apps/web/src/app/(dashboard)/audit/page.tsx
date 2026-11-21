'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api-client';

export default function AuditPage() {
  const [projectId, setProjectId] = useState('');
  const [logs, setLogs] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string | null>(null);

  async function load(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const data = await apiFetch<Array<Record<string, unknown>>>(
        `/dashboard/audit?projectId=${encodeURIComponent(projectId)}`,
      );
      setLogs(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit logs');
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">Audit Logs</h1>
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
      <pre className="overflow-x-auto rounded-lg border border-slate-200 bg-white p-4 text-xs">
        {JSON.stringify(logs, null, 2)}
      </pre>
    </div>
  );
}
