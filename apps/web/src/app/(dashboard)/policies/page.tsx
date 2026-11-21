'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api-client';

export default function PoliciesPage() {
  const [projectId, setProjectId] = useState('');
  const [policies, setPolicies] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string | null>(null);

  async function load(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const data = await apiFetch<Array<Record<string, unknown>>>(
        `/dashboard/policies?projectId=${encodeURIComponent(projectId)}`,
      );
      setPolicies(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load policies');
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">Policies</h1>
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
          Load Policies
        </button>
      </form>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <pre className="overflow-x-auto rounded-lg border border-slate-200 bg-white p-4 text-xs">
        {JSON.stringify(policies, null, 2)}
      </pre>
    </div>
  );
}
