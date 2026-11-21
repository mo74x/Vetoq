'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import type { EditableSchemaMap } from '@hitl/shared';
import { EditableForm } from '@/components/review/editable-form';

interface ReviewContext {
  request_id: string;
  action_type: string;
  title: string;
  summary: string | null;
  agent_name: string | null;
  status: string;
  payload_version: number;
  edit_count: number;
  max_edit_rounds: number;
  required_approvals: number;
  original_payload: Record<string, unknown>;
  current_payload: Record<string, unknown>;
  editable_schema: EditableSchemaMap | null;
  expires_at: string;
  approver_email: string;
  action_nonce: string;
  organization: {
    name: string;
    slug: string;
    branding: { logo_url?: string; accent_color?: string };
  };
}

export default function ReviewPortalPage() {
  const params = useParams<{ orgSlug: string; token: string }>();
  const [context, setContext] = useState<ReviewContext | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await fetch(`/api/v1/review/${encodeURIComponent(params.token)}`);
        if (!res.ok) {
          throw new Error(`Unable to load review (${res.status})`);
        }
        const data = (await res.json()) as ReviewContext;
        if (!active) return;
        setContext(data);
        // Explicit client-side viewed beacon (never triggered by GET prefetches)
        void fetch(`/api/v1/review/${encodeURIComponent(params.token)}/viewed`, {
          method: 'POST',
        });
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load review');
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [params.token]);

  if (error) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-700">
          {error}
        </div>
      </main>
    );
  }

  if (!context) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-sm text-slate-500">
        Loading approval request...
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 pb-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
              {context.organization.name} · {context.action_type}
            </p>
            <h1 className="mt-1 text-xl font-semibold text-slate-900">{context.title}</h1>
          </div>
          <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800">
            v{context.payload_version}
          </span>
        </div>

        {context.summary && <p className="mt-4 text-sm text-slate-600">{context.summary}</p>}

        <div className="mt-6">
          <EditableForm
            token={params.token}
            actionNonce={context.action_nonce}
            payloadVersion={context.payload_version}
            originalPayload={context.original_payload}
            currentPayload={context.current_payload}
            editableSchema={context.editable_schema}
            accentColor={context.organization.branding?.accent_color}
          />
        </div>
      </div>
    </main>
  );
}
