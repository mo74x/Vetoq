'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';

interface Project {
  id: string;
  name: string;
  defaultApproverEmails: string[];
  createdAt: string;
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState('');
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const data = await apiFetch<Project[]>('/dashboard/projects');
      setProjects(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await apiFetch<Project & { webhook_secret: string }>('/dashboard/projects', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      setCreatedSecret(res.webhook_secret);
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">Projects</h1>
      <form onSubmit={createProject} className="flex gap-3">
        <input
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Client project name"
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white"
        >
          Create Project
        </button>
      </form>
      {createdSecret && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
          Save this webhook secret: <code className="font-mono">{createdSecret}</code>
        </div>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
        {projects.map((p) => (
          <div key={p.id} className="flex items-center justify-between px-4 py-3 text-sm">
            <div>
              <p className="font-medium text-slate-900">{p.name}</p>
              <p className="text-xs text-slate-500">{p.id}</p>
            </div>
          </div>
        ))}
        {projects.length === 0 && (
          <p className="px-4 py-6 text-sm text-slate-500">No projects yet.</p>
        )}
      </div>
    </div>
  );
}
