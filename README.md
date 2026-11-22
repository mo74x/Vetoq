# Vetoq — Human-in-the-Loop (HITL) Guardrail & Approval Layer

**Vetoq** is a full-stack TypeScript monorepo that sits between AI agents (n8n, LangGraph, Vercel AI SDK, MCP servers, TypeScript/Python services) and high-stakes real-world actions (refunds, outbound emails, database writes). It evaluates deterministic policies, enforces velocity and spend circuit breakers, pauses execution for human review via **anti-prefetch magic links** or **Slack Block Kit edit modals**, and resumes downstream workflows with **HMAC-SHA256 signed webhooks** and **append-only PostgreSQL audit logs**.

---

## System Architecture

```mermaid
flowchart LR
  Agents["AI Agents & Workflows\n(n8n, LangGraph, Vercel AI, MCP, Python/TS)"] -->|"POST /v1/approvals\n(Bearer API Key + Idempotency-Key)"| API["@hitl/api (NestJS 12)"]
  API -->|"Evaluate Policies &\nCircuit Breakers"| PG[("PostgreSQL 16\n(Drizzle ORM + Immutable Audit Trigger)")]
  API -->|"Schedule Timeouts,\nEmails & Webhooks"| Redis[("Redis 7 + BullMQ\n(Rate Limits + Nonce SET NX)")]
  Redis -->|"Dispatch Review Email\n& OTP Code"| Email["Resend Email"]
  Redis -->|"Post Block Kit Card\n& Edit Modal"| Slack["Slack Workspace"]
  Slack -->|"POST /v1/slack/interactions\n(X-Slack-Signature)"| API
  Email -->|"GET /p/:orgSlug/review/:token\nor Custom Domain /review/:token"| Web["@hitl/web (Next.js 16)\nReview Portal & Agency Console"]
  Web -->|"POST /api/v1/review/:token/decide\n(Same-Origin Rewrite)"| API
  Redis -->|"DNS-Pinned SSRF-Safe POST\n(X-Signature-256 + X-HITL-Timestamp)"| Agents
```

---

## Core Lifecycle & Anti-Prefetch Flow

### Approval & Webhook State Machine

```mermaid
stateDiagram-v2
  [*] --> auto_approved: "Matches auto_approve & breaker armed (200 OK)"
  [*] --> auto_rejected: "Matches auto_reject (200 OK)"
  [*] --> pending: "Requires human review or fail-closed fallback (202 Accepted)"

  pending --> pending: "Vote recorded or payload edited (resets prior votes, max 3 rounds)"
  pending --> approved: "Quorum reached without edits"
  pending --> edited_and_approved: "Quorum reached after validated edit"
  pending --> rejected: "Reviewer rejects or edit matches auto_reject"
  pending --> timed_out: "BullMQ timeout or 15s reconciliation sweep"

  approved --> [*]
  edited_and_approved --> [*]
  rejected --> [*]
  timed_out --> [*]
```

### Anti-Prefetch Magic-Link & Transactional Outbox Sequence

Email security scanners (Outlook Safe Links, Mimecast, Proofpoint) pre-fetch `GET` links. Vetoq keeps `GET` **100% read-only** and binds every decision to a stateless HMAC `action_nonce` + Redis single-use lock:

```mermaid
sequenceDiagram
  participant Scanner as Email Scanner / Browser
  participant Web as "@hitl/web (Next.js 16)"
  participant API as "@hitl/api (NestJS 12)"
  participant Redis as Redis
  participant PG as PostgreSQL

  Scanner->>Web: GET /p/:orgSlug/review/:token
  Web->>API: GET /v1/review/:token (zero DB writes)
  API-->>Web: Context + stateless HMAC action_nonce (15m TTL)
  Web->>API: POST /v1/review/:token/viewed (client beacon)
  Note over Web,API: Optional: POST /v1/review/:token/otp -> 6-digit email code
  Web->>API: POST /v1/review/:token/decide (action_nonce + otp_code + edited_fields)
  API->>Redis: SET nonce:<jti> 1 EX 900 NX (rejects replay with 409)
  API->>PG: BEGIN -> SELECT ... FOR UPDATE -> validate edits -> update votes/status -> INSERT webhook_deliveries (outbox) -> COMMIT
  API->>Redis: Remove timeout_<id> & enqueue deliver-webhook
```

---

## Feature & Security Matrix

| Capability | Implementation Details |
| :--- | :--- |
| **Fail-Closed Policy Engine** | Evaluates active rules ordered by `priority ASC` (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`) with prototype-safe dot-path resolution. Unmatched actions or parse errors fail closed to `require_approval`. |
| **Velocity & Spend Circuit Breakers** | Rolling Redis counters (`max_requests_per_hour`, `max_cumulative_amount_per_day`) per project and action type. When tripped, `auto_approve` is frozen into `require_approval` (`pending`) until reset in `/policies`. |
| **Validated Edit-Before-Execute** | Typed `editable_schema` (`string`, `textarea`, `number`, `boolean`, `enum`) enforced server-side (`min`, `max`, `maxLength`, `editable: false` rejection), producing RFC 6902 JSON diffs (`fast-json-patch`) and re-running policy evaluation on `final_payload`. |
| **Multi-Approver Consensus** | `approval_votes` bound to `payload_version`. Any edit increments `payload_version` (capped at 3 rounds), marks prior votes `superseded_at = NOW()`, and re-notifies reviewers. |
| **Slack Block Kit + Edit Modal** | `SlackService` posts Approve / Edit & Approve / Reject cards. Clicking **Edit & Approve** opens a `views.open` modal generated from `editable_schema`; `view_submission` validates edits and resolves the request atomically. |
| **Custom Agency Domains** | `apps/web/src/middleware.ts` resolves `organizations.custom_domain` via `/v1/review/resolve-domain` and rewrites `/review/:token` → `/p/:orgSlug/review/:token`. |
| **Policy-Driven Email OTP** | Policies with `require_otp = true` require a 6-digit email code (`POST /v1/review/:token/otp`, 10-minute TTL, max 5 failed attempts) before `decide` succeeds. |
| **SSRF & Webhook Reliability** | Blocks private/loopback/link-local CIDRs (`ipaddr.js`), pins the resolved DNS IP in a custom HTTP `lookup` hook, disables redirects (`redirect: 'manual'`), truncates error bodies to 4 KB, stops early on `400`/`404`/`410`, and recovers dropped jobs via a 15-second reconciliation sweep. |
| **Append-Only Audit & Evidence Pack** | `audit_logs` is protected by `ON DELETE RESTRICT` and PostgreSQL trigger `trg_audit_logs_immutable`. Export CSV (`GET /v1/dashboard/audit/export`) or full `vetoq.evidence.v1` JSON bundles (`GET /v1/dashboard/audit/evidence/:id`). |
| **MoR Billing & Plan Quotas** | `POST /v1/billing/webhooks/mor` verifies HMAC signatures idempotently (`billing_events`) and updates `organizations.plan` (`free`: 300/mo & 1 project; `pro`: 5,000/mo & 10 projects; `agency`: 25,000/mo; `enterprise`: unlimited). |

---

## Monorepo Structure

```text
.
├── apps/
│   ├── api/                 # @hitl/api — NestJS 12 REST API, Better Auth, BullMQ workers, Slack & Billing
│   └── web/                 # @hitl/web — Next.js 16 agency console, /sandbox, & magic-link review portal
├── packages/
│   ├── shared/              # @hitl/shared — Zod contracts, policy evaluator, edit validator, SSRF checks
│   ├── db/                  # @hitl/db — Drizzle ORM schema & PostgreSQL migrations (0000–0005)
│   ├── sdk/                 # @hitl/sdk — TypeScript SDK (AgentGate & verifyWebhookSignature)
│   ├── mcp/                 # @hitl/mcp — MCP tool approval middleware (wrapToolWithApproval)
│   ├── adapters/            # @hitl/adapters — LangGraph & Vercel AI SDK adapters
│   └── n8n-node/            # n8n-nodes-vetoq — Publishable n8n community node & credentials
├── sdks/
│   └── python/              # hitl-sdk — Zero-dependency Python SDK
├── templates/
│   └── n8n/                 # Zero-install n8n workflow JSON (works on n8n Cloud & self-hosted)
├── docker-compose.yml       # PostgreSQL 16 + Redis 7
└── .env.example             # Environment variable template
```

---

## Local Setup

### 1. Prerequisites
* **Node.js** `>= 20.19.0` (tested on `v24.11.1`)
* **pnpm** `>= 9.0.0`
* **PostgreSQL 16** and **Redis 7** (via Docker Compose or DBngin)

### 2. Install & Configure Environment
```bash
pnpm install
cp .env.example .env
```

| Variable | Purpose |
| :--- | :--- |
| `DATABASE_URL` | PostgreSQL connection string (`postgresql://hitl:hitl_dev_password@localhost:5432/hitl_dev` for Docker, or `postgresql://postgres@localhost:5432/hitl_dev` for DBngin) |
| `REDIS_URL` | Redis connection string (`redis://127.0.0.1:6379`) |
| `APP_ENCRYPTION_KEY` | 64-char hex (32-byte) key for AES-256-GCM encryption of webhook/Slack secrets |
| `ACTION_NONCE_SECRET` | 64-char hex (32-byte) key for stateless `action_nonce` HMAC signing |
| `BETTER_AUTH_SECRET` | Random secret (`>= 32` chars) for Better Auth sessions |
| `BETTER_AUTH_URL` / `WEB_URL` | Public `apps/web` origin (`http://localhost:3000`) |
| `API_INTERNAL_URL` | Internal `apps/api` URL used by Next.js rewrites (`http://localhost:3001`) |
| `RESEND_API_KEY` / `EMAIL_FROM` | Resend API key and sender address (logs URLs/OTPs to console when using `re_test_placeholder`) |
| `BILLING_WEBHOOK_SECRET` | HMAC-SHA256 secret for `POST /v1/billing/webhooks/mor` |

### 3. Start Services, Build & Migrate
```bash
# If using Docker Compose:
docker compose up -d --wait

# Build all packages and apply Drizzle migrations:
pnpm turbo build
pnpm db:migrate
```

### 4. Run in Development
```bash
pnpm dev
```
* **Landing Page & No-Signup Sandbox:** `http://localhost:3000` and `http://localhost:3000/sandbox`
* **Agency Console:** `http://localhost:3000/projects`, `/policies`, `/queue`, `/webhooks`, `/audit`
* **API Healthcheck:** `GET http://localhost:3001/healthz`

---

## Verification & Testing

```bash
pnpm turbo build                 # Build all 8 workspace packages
pnpm turbo typecheck             # Strict TypeScript check across all packages
pnpm turbo lint                  # ESLint across all packages
pnpm turbo test                  # 15 Vitest unit tests (@hitl/shared, @hitl/sdk, @hitl/mcp, @hitl/adapters)
pnpm --filter @hitl/api test:e2e # NestJS E2E integration tests against live Postgres + Redis
```

---

## API Reference

| Endpoint | Auth | Description |
| :--- | :--- | :--- |
| `POST /v1/approvals` | `Bearer hk_live_...` | Ingest action; returns `200` (`auto_approved`/`auto_rejected`) or `202` (`pending`) |
| `GET /v1/approvals` | `Bearer hk_live_...` | List project approval requests |
| `GET /v1/approvals/:id` | `Bearer hk_live_...` | Poll request status and `finalPayload` |
| `GET /v1/review/:token` | Magic-link token | Read-only context, `require_otp` flag, and stateless `action_nonce` |
| `POST /v1/review/:token/viewed` | Magic-link token | Explicit client beacon recording `viewed` in `audit_logs` |
| `POST /v1/review/:token/otp` | Magic-link token | Generate and email 6-digit OTP (10m TTL) |
| `POST /v1/review/:token/decide` | Magic-link + `action_nonce` | Submit `approve`/`reject`, `edited_fields`, and optional `otp_code` |
| `GET /v1/review/resolve-domain` | Public (`?host=...`) | Resolve custom agency domain to organization `slug` |
| `POST /v1/slack/interactions` | `X-Slack-Signature` | Handle Slack Block Kit Approve / Reject / Edit Modal submissions |
| `POST /v1/billing/webhooks/mor` | `X-Billing-Signature` | Idempotent MoR subscription sync (`organizations.plan`) |
| `GET/POST/PATCH/DELETE /v1/dashboard/projects*` | Better Auth Session | Manage projects, API keys, webhook secret rotation, Slack config, branding, offboarding |
| `GET/POST/DELETE /v1/dashboard/policies*` | Better Auth Session | Manage policy rules and velocity/spend circuit breakers (`.../reset`) |
| `GET/POST /v1/dashboard/approvals*` | Better Auth Session | Inspect queue, webhook deliveries, and manual `.../retry` |
| `GET /v1/dashboard/audit*` | Better Auth Session | Query audit logs, export CSV, or download `vetoq.evidence.v1` JSON packs |
| `GET /healthz` | Public | Verify live PostgreSQL and Redis connectivity |

---

## Integrations & SDK Examples

### 1. n8n (Zero-Install Template or `n8n-nodes-vetoq`)
* **n8n Cloud & Self-Hosted:** Import `templates/n8n/hitl-approval-workflow.json` (`HTTP Request` → `IF status === 'pending'` → `Wait` → `Code` HMAC-SHA256 verification).
* **Community Node:** Use `packages/n8n-node` (`n8n-nodes-vetoq`) with `VetoqApi` credentials.

### 2. TypeScript SDK (`@hitl/sdk`)
```typescript
import { AgentGate } from '@hitl/sdk';

const gate = new AgentGate({ apiKey: process.env.HITL_API_KEY!, baseUrl: process.env.HITL_API_URL });
const decision = await gate.requestAndWait({
  actionType: 'stripe.refund',
  title: 'Refund Order #98421',
  payload: { order_id: 'ord_98421', refund_amount_usd: 240 },
});
if (decision.isApproved) console.log(decision.finalPayload);
```

### 3. MCP Middleware (`@hitl/mcp`)
```typescript
import { AgentGate } from '@hitl/sdk';
import { wrapToolWithApproval } from '@hitl/mcp';

const gate = new AgentGate({ apiKey: process.env.HITL_API_KEY! });
const safeRefund = wrapToolWithApproval(
  async (args: { order_id: string; refund_amount_usd: number }) => ({ refunded: true, ...args }),
  { gate, actionType: 'stripe.refund', title: (a) => `Refund ${a.order_id}` },
);
```

### 4. LangGraph & Vercel AI SDK (`@hitl/adapters`)
```typescript
import { AgentGate } from '@hitl/sdk';
import { createLangGraphApprovalNode, withVetoqVercelTool } from '@hitl/adapters';

const gate = new AgentGate({ apiKey: process.env.HITL_API_KEY! });

// Vercel AI SDK tool wrapper
const protectedTool = withVetoqVercelTool(
  { execute: async (args: { amount: number }) => ({ charged: args.amount }) },
  { gate, actionType: 'stripe.refund', title: 'Approve refund' },
);

// LangGraph node
const approvalNode = createLangGraphApprovalNode({
  gate,
  actionType: 'email.send',
  title: 'Approve outbound email',
  getPayload: (state: { draft: Record<string, unknown> }) => state.draft,
});
```

### 5. Python SDK (`sdks/python/hitl_sdk`)
```python
from hitl_sdk import AgentGate

gate = AgentGate(api_key="hk_live_...", base_url="http://localhost:3001")
decision = gate.request_and_wait(
    action_type="stripe.refund",
    title="Refund Order #98421",
    payload={"order_id": "ord_98421", "refund_amount_usd": 240},
)
if decision["is_approved"]:
    print(decision["final_payload"])
```
