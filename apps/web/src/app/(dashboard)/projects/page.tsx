'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { authClient } from '@/lib/auth-client';

interface Project {
  id: string;
  name: string;
  defaultApproverEmails: string[];
  defaultSlackChannel?: string | null;
  hasSlackConfigured?: boolean;
  createdAt: string;
}

interface ApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export default function ProjectsPage() {
  const { data: session } = authClient.useSession();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [apiKeys, setApiKeys] = useState<ApiKeyRow[]>([]);
  const [name, setName] = useState('');
  const [defaultApprovers, setDefaultApprovers] = useState('');
  const [newKeyName, setNewKeyName] = useState('');
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [revealedApiKey, setRevealedApiKey] = useState<string | null>(null);

  // Org setup / branding
  const [orgName, setOrgName] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [accentColor, setAccentColor] = useState('#0f172a');
  const [slackChannel, setSlackChannel] = useState('');
  const [slackBotToken, setSlackBotToken] = useState('');
  const [slackSigningSecret, setSlackSigningSecret] = useState('');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadProjects() {
    setError(null);
    try {
      const data = await apiFetch<Project[]>('/dashboard/projects');
      setProjects(data);
      if (data.length > 0 && !selectedProjectId) {
        setSelectedProjectId(data[0].id);
        setDefaultApprovers(data[0].defaultApproverEmails.join(', '));
      }
      const branding = await apiFetch<{
        brandingConfig?: { logo_url?: string; accent_color?: string };
      }>('/dashboard/projects/branding');
      if (branding.brandingConfig?.logo_url) setLogoUrl(branding.brandingConfig.logo_url);
      if (branding.brandingConfig?.accent_color) setAccentColor(branding.brandingConfig.accent_color);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects');
    }
  }

  async function loadKeys(projectId: string) {
    if (!projectId) return;
    try {
      const keys = await apiFetch<ApiKeyRow[]>(`/dashboard/projects/${projectId}/api-keys`);
      setApiKeys(keys);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load API keys');
    }
  }

  useEffect(() => {
    void loadProjects();
  }, []);

  useEffect(() => {
    if (selectedProjectId) {
      void loadKeys(selectedProjectId);
      const proj = projects.find((p) => p.id === selectedProjectId);
      if (proj) {
        setDefaultApprovers(proj.defaultApproverEmails.join(', '));
        setSlackChannel(proj.defaultSlackChannel ?? '');
      }
    }
  }, [selectedProjectId]);

  async function createOrganization(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const slug = orgName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      const created = await authClient.organization.create({ name: orgName, slug });
      if (created.error) throw new Error(created.error.message ?? 'Failed to create organization');
      if (created.data?.id) {
        await authClient.organization.setActive({ organizationId: created.data.id });
      }
      setOrgName('');
      await loadProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create organization');
    }
  }

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await apiFetch<Project & { webhook_secret: string }>('/dashboard/projects', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      setRevealedSecret(res.webhook_secret);
      setName('');
      setSelectedProjectId(res.id);
      await loadProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
    }
  }

  async function saveDefaultApprovers(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedProjectId) return;
    setError(null);
    try {
      const emails = defaultApprovers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      await apiFetch(`/dashboard/projects/${selectedProjectId}`, {
        method: 'PATCH',
        body: JSON.stringify({ default_approver_emails: emails }),
      });
      setStatusMsg('Default approver emails saved.');
      await loadProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update project');
    }
  }

  async function rotateWebhookSecret() {
    if (!selectedProjectId) return;
    setError(null);
    try {
      const res = await apiFetch<{ webhook_secret: string }>(
        `/dashboard/projects/${selectedProjectId}/rotate-webhook-secret`,
        { method: 'POST' },
      );
      setRevealedSecret(res.webhook_secret);
      setStatusMsg('Webhook secret rotated (previous secret kept active for in-flight webhooks).');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rotate secret');
    }
  }

  async function createApiKey(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedProjectId) return;
    setError(null);
    try {
      const res = await apiFetch<{ api_key: string }>(
        `/dashboard/projects/${selectedProjectId}/api-keys`,
        {
          method: 'POST',
          body: JSON.stringify({ name: newKeyName || 'Production Key' }),
        },
      );
      setRevealedApiKey(res.api_key);
      setNewKeyName('');
      await loadKeys(selectedProjectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create API key');
    }
  }

  async function revokeApiKey(keyId: string) {
    if (!selectedProjectId) return;
    setError(null);
    try {
      await apiFetch(`/dashboard/projects/${selectedProjectId}/api-keys/${keyId}`, {
        method: 'DELETE',
      });
      await loadKeys(selectedProjectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke API key');
    }
  }

  async function saveBranding(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/dashboard/projects/branding', {
        method: 'PATCH',
        body: JSON.stringify({ logo_url: logoUrl, accent_color: accentColor }),
      });
      setStatusMsg('Organization branding updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save branding');
    }
  }

  async function saveSlackConfig(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedProjectId) return;
    setError(null);
    try {
      await apiFetch(`/dashboard/projects/${selectedProjectId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          default_slack_channel: slackChannel,
          ...(slackBotToken.trim() ? { slack_bot_token: slackBotToken } : {}),
          ...(slackSigningSecret.trim() ? { slack_signing_secret: slackSigningSecret } : {}),
        }),
      });
      setSlackBotToken('');
      setSlackSigningSecret('');
      setStatusMsg('Slack integration updated.');
      await loadProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save Slack settings');
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-slate-900">Projects &amp; Credentials</h1>
        {!session?.session?.activeOrganizationId && (
          <form onSubmit={createOrganization} className="flex gap-2">
            <input
              type="text"
              required
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="New Agency Org Name"
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
            />
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
            >
              Create Org
            </button>
          </form>
        )}
      </div>

      {statusMsg && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {statusMsg}
        </div>
      )}
      {revealedSecret && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
          Webhook secret (copy now): <code className="font-mono font-semibold">{revealedSecret}</code>
        </div>
      )}
      {revealedApiKey && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
          API Key (shown once): <code className="font-mono font-semibold">{revealedApiKey}</code>
        </div>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-base font-semibold text-slate-900">Create Client Project</h2>
        <form onSubmit={createProject} className="mt-3 flex gap-3">
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Client project name"
            className="w-72 rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white"
          >
            Create Project
          </button>
        </form>

        <div className="mt-4 divide-y divide-slate-200 rounded-md border border-slate-200">
          {projects.map((p) => (
            <div
              key={p.id}
              onClick={() => setSelectedProjectId(p.id)}
              className={`flex cursor-pointer items-center justify-between px-4 py-3 text-sm ${
                selectedProjectId === p.id ? 'bg-slate-50 font-medium' : 'hover:bg-slate-50'
              }`}
            >
              <div>
                <p className="text-slate-900">{p.name}</p>
                <p className="font-mono text-xs text-slate-500">{p.id}</p>
              </div>
              <span className="text-xs text-slate-500">
                {selectedProjectId === p.id ? 'Selected' : 'Select'}
              </span>
            </div>
          ))}
          {projects.length === 0 && (
            <p className="px-4 py-4 text-sm text-slate-500">No projects yet.</p>
          )}
        </div>
      </section>

      {selectedProjectId && (
        <section className="grid gap-6 md:grid-cols-2">
          <div className="rounded-lg border border-slate-200 bg-white p-6">
            <h2 className="text-base font-semibold text-slate-900">API Keys</h2>
            <form onSubmit={createApiKey} className="mt-3 flex gap-2">
              <input
                type="text"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="Key name (e.g. n8n Prod)"
                className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
              <button
                type="submit"
                className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white"
              >
                Generate Key
              </button>
            </form>
            <div className="mt-4 divide-y divide-slate-200">
              {apiKeys.map((k) => (
                <div key={k.id} className="flex items-center justify-between py-2.5 text-sm">
                  <div>
                    <p className="font-medium text-slate-800">{k.name}</p>
                    <p className="font-mono text-xs text-slate-500">{k.keyPrefix}...</p>
                  </div>
                  {k.revokedAt ? (
                    <span className="text-xs text-red-600">Revoked</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => revokeApiKey(k.id)}
                      className="text-xs text-red-600 hover:underline"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              ))}
              {apiKeys.length === 0 && (
                <p className="py-3 text-xs text-slate-500">No API keys created yet.</p>
              )}
            </div>
          </div>

          <div className="space-y-6 rounded-lg border border-slate-200 bg-white p-6">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Fallback Approvers &amp; Webhook Secret
              </h2>
              <form onSubmit={saveDefaultApprovers} className="mt-3 space-y-2">
                <label className="block text-xs font-medium text-slate-600">
                  Default Approver Emails (comma-separated)
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={defaultApprovers}
                    onChange={(e) => setDefaultApprovers(e.target.value)}
                    placeholder="client@company.com, lead@agency.com"
                    className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                  <button
                    type="submit"
                    className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white"
                  >
                    Save
                  </button>
                </div>
              </form>
              <button
                type="button"
                onClick={rotateWebhookSecret}
                className="mt-4 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Rotate Webhook Secret
              </button>
            </div>

            <form onSubmit={saveBranding} className="space-y-3 border-t border-slate-200 pt-4">
              <h3 className="text-sm font-semibold text-slate-900">Agency Portal Branding</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <input
                  type="url"
                  value={logoUrl}
                  onChange={(e) => setLogoUrl(e.target.value)}
                  placeholder="Logo URL (optional)"
                  className="rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={accentColor}
                    onChange={(e) => setAccentColor(e.target.value)}
                    className="h-9 w-12 rounded border border-slate-300"
                  />
                  <input
                    type="text"
                    value={accentColor}
                    onChange={(e) => setAccentColor(e.target.value)}
                    className="flex-1 rounded-md border border-slate-300 px-3 py-2 font-mono text-xs"
                  />
                </div>
              </div>
              <button
                type="submit"
                className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white"
              >
                Save Branding
              </button>
            </form>

            <form onSubmit={saveSlackConfig} className="space-y-3 border-t border-slate-200 pt-4">
              <h3 className="text-sm font-semibold text-slate-900">Slack Block Kit Integration</h3>
              <div className="space-y-2">
                <input
                  type="text"
                  value={slackChannel}
                  onChange={(e) => setSlackChannel(e.target.value)}
                  placeholder="Default Slack Channel ID (e.g. C01234567)"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
                <input
                  type="password"
                  value={slackBotToken}
                  onChange={(e) => setSlackBotToken(e.target.value)}
                  placeholder="Slack Bot Token (xoxb-..., leave blank to keep)"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
                <input
                  type="password"
                  value={slackSigningSecret}
                  onChange={(e) => setSlackSigningSecret(e.target.value)}
                  placeholder="Slack Signing Secret (leave blank to keep)"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <button
                type="submit"
                className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white"
              >
                Save Slack Settings
              </button>
            </form>
          </div>
        </section>
      )}
    </div>
  );
}
