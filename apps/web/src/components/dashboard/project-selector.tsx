'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';

interface ProjectOption {
  id: string;
  name: string;
}

interface ProjectSelectorProps {
  value: string;
  onChange: (projectId: string) => void;
}

export function ProjectSelector({ value, onChange }: ProjectSelectorProps) {
  const [projects, setProjects] = useState<ProjectOption[]>([]);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const list = await apiFetch<ProjectOption[]>('/dashboard/projects');
        if (!active) return;
        setProjects(list);
        const saved = typeof window !== 'undefined' ? window.localStorage.getItem('vetoq_project_id') : null;
        if (!value) {
          const initial =
            saved && list.some((p) => p.id === saved) ? saved : list[0]?.id ?? '';
          if (initial) onChange(initial);
        }
      } catch {
        // Ignore when unauthenticated; parent pages display errors on fetch
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, []);

  function handleSelect(nextId: string) {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('vetoq_project_id', nextId);
    }
    onChange(nextId);
  }

  return (
    <select
      value={value}
      onChange={(e) => handleSelect(e.target.value)}
      className="w-72 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
    >
      {projects.length === 0 && <option value="">No projects found</option>}
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}
