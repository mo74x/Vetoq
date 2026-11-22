# Vetoq — Human-in-the-Loop (HITL) Approval Layer

A TypeScript monorepo providing a Human-in-the-Loop approval API, policy engine, branded magic-link review portal, Slack integration, n8n workflow template, and TypeScript/Python/MCP SDKs for AI agents and automated workflows.

---

## Key Capabilities

* **Deterministic Fail-Closed Policy Engine (`@hitl/shared`):** Evaluates active rules ordered by `priority ASC` (`auto_approve`, `require_approval`, `auto_reject`) using AND-ed predicates (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`). Unmatched actions or condition parse errors fail closed to `require_approval`.
* **Edit-Before-Execute (`editable_schema`):** Renders typed review forms (`string`, `textarea`, `number`, `boolean`, `enum`), enforces field mutability and bounds (`min`, `max`, `maxLength`) on the server, generates RFC 6902 JSON diffs (`fast-json-patch`), and re-runs policy evaluation on `final_payload`.
* **Anti-Prefetch Magic-Link Portal (`apps/web`):** `GET /v1/review/:token` is strictly read-only (zero DB writes) and issues a 15-minute stateless HMAC-signed `action_nonce` consumed once via Redis `SET NX` on `POST /v1/review/:token/decide`.
* **Multi-Approver Consensus with Edit Reset:** Tracks per-approver votes bound to `payload_version` in `approval_votes`. Editing the payload (up to 3 edit rounds) supersedes prior votes and re-notifies reviewers to confirm the updated payload.
* **Crash-Safe Webhooks & SLA Timeouts:** Terminal decisions write `webhook_deliveries` in the same PostgreSQL transaction as `approval_requests`, backed by BullMQ workers (`timeout`, `webhook`, `email`, `reconciliation`), DNS-pinned SSRF protection (`redirect: 'manual'`), and `HMAC-SHA256` webhook signing (`X-HITL-Timestamp` + `X-Signature-256`).
* **Append-Only Audit Logs:** Protected by `ON DELETE RESTRICT` and a PostgreSQL `BEFORE UPDATE OR DELETE` trigger (`trg_audit_logs_immutable`).
* **Production Controls & Developer Surfaces:** Redis-backed per-IP/per-token rate limiting, `/healthz` readiness checks, structured `X-Request-Id` JSON logging, MoR billing webhook handler (`POST /v1/billing/webhooks/mor`) with plan quotas, project offboarding/PII redaction, Slack Block Kit interactions (`POST /v1/slack/interactions`), `@hitl/sdk`, `@hitl/mcp`, and `hitl-sdk` (Python).

---

## Monorepo Structure

```text
.
├── apps/
│   ├── api/                 # @hitl/api — NestJS 12 REST API, Better Auth, BullMQ workers
│   └── web/                 # @hitl/web — Next.js 16 agency console & magic-link review portal
├── packages/
│   ├── shared/              # @hitl/shared — Zod schemas, policy evaluator, edit validator, SSRF checks
│   ├── db/                  # @hitl/db — Drizzle ORM schema & PostgreSQL migrations
│   ├── sdk/                 # @hitl/sdk — TypeScript SDK (AgentGate & verifyWebhookSignature)
│   └── mcp/                 # @hitl/mcp — MCP tool approval wrapper (wrapToolWithApproval)
├── sdks/
│   └── python/              # hitl-sdk — Zero-dependency Python SDK
├── templates/
│   └── n8n/                 # Importable n8n workflow JSON (HTTP + IF + Wait + HMAC Code node)
├── docker-compose.yml       # PostgreSQL 16 + Redis 7
└── .env.example             # Environment variable template
```

---

## Tech Stack

* **Monorepo:** Turborepo + pnpm (`engines.node >= 20.19.0`)
* **Backend & Workers:** NestJS 12, Zod, BullMQ, ioredis, Resend, Better Auth (`organization` plugin)
* **Frontend:** Next.js 16, React 19, Tailwind CSS v4
* **Database:** PostgreSQL 16 + Drizzle ORM

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

Edit `.env` to match your local database and Redis URLs:
* For **Docker Compose**: `DATABASE_URL=postgresql://hitl:hitl_dev_password@localhost:5432/hitl_dev`, `REDIS_URL=redis://127.0.0.1:6379`
* For **DBngin**: `DATABASE_URL=postgresql://postgres@localhost:5432/hitl_dev`, `REDIS_URL=redis://127.0.0.1:6379`

### 3. Start Services & Run Migrations
```bash
# If using Docker Compose:
docker compose up -d --wait

# Build packages & apply Drizzle migrations:
pnpm turbo build
pnpm db:migrate
```

### 4. Run in Development
```bash
pnpm dev
```
* **Agency Console & Review Portal:** `http://localhost:3000`
* **API Server:** `http://localhost:3001` (proxied through `apps/web` via `/api/auth/*` and `/api/v1/*`)
* **Healthcheck:** `GET http://localhost:3001/healthz`

---

## Verification & Testing

```bash
# Build all packages
pnpm turbo build

# Typecheck all packages
pnpm turbo typecheck

# Lint all packages
pnpm turbo lint

# Unit tests (@hitl/shared)
pnpm --filter @hitl/shared test

# API E2E integration tests (requires running PostgreSQL + Redis and applied migrations)
pnpm --filter @hitl/api test:e2e
```

---

## API Reference Summary

| Endpoint | Auth | Purpose |
| :--- | :--- | :--- |
| `POST /v1/approvals` | `Bearer hk_live_...` | Submit action for policy evaluation (`200` sync auto-decision or `202` pending) |
| `GET /v1/approvals` | `Bearer hk_live_...` | List project approval requests |
| `GET /v1/approvals/:id` | `Bearer hk_live_...` | Poll single approval request status & `finalPayload` |
| `GET /v1/review/:token` | Magic-link token | Read-only review context + stateless `action_nonce` |
| `POST /v1/review/:token/viewed` | Magic-link token | Explicit client beacon logging `viewed` in `audit_logs` |
| `POST /v1/review/:token/decide` | Magic-link + `action_nonce` | Submit `approve`/`reject` and optional `edited_fields` |
| `POST /v1/slack/interactions` | Slack `X-Slack-Signature` | Handle Slack Block Kit Approve/Reject button clicks |
| `POST /v1/billing/webhooks/mor` | `X-Billing-Signature` | Idempotent MoR subscription sync (`organizations.plan`) |
| `GET /v1/dashboard/*` | Better Auth Session | Manage projects, API keys, policies, queue, webhooks, audit CSV export |
| `GET /healthz` | Public | Verify PostgreSQL and Redis connectivity |

---

## Integrations & SDK Usage

### 1. n8n Workflow Template (Cloud & Self-Hosted)
Import `templates/n8n/hitl-approval-workflow.json` into n8n and configure `HITL_API_URL`, `HITL_API_KEY`, and `HITL_WEBHOOK_SECRET` environment variables. The workflow routes `status === 'pending'` into the `Wait` node and verifies `X-Signature-256` and `X-HITL-Timestamp` (`<= 300s` skew) before executing downstream actions with `final_payload`.

### 2. TypeScript SDK (`@hitl/sdk`)
```typescript
import { AgentGate } from '@hitl/sdk';

const gate = new AgentGate({
  apiKey: process.env.HITL_API_KEY!,
  baseUrl: process.env.HITL_API_URL,
});

const decision = await gate.requestAndWait({
  actionType: 'stripe.refund',
  title: 'Refund Order #98421',
  payload: { order_id: 'ord_98421', refund_amount_usd: 240 },
  timeoutMs: 15 * 60 * 1000,
});

if (decision.isApproved) {
  // Always execute with decision.finalPayload
  console.log(decision.finalPayload);
}
```

### 3. MCP Tool Wrapper (`@hitl/mcp`)
```typescript
import { AgentGate } from '@hitl/sdk';
import { wrapToolWithApproval } from '@hitl/mcp';

const gate = new AgentGate({ apiKey: process.env.HITL_API_KEY! });

const safeRefundTool = wrapToolWithApproval(
  async (args: { order_id: string; refund_amount_usd: number }) => {
    return { refunded: true, ...args };
  },
  {
    gate,
    actionType: 'stripe.refund',
    title: (args) => `Issue refund for ${args.order_id}`,
  },
);
```

### 4. Python SDK (`sdks/python/hitl_sdk`)
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
