# Human-in-the-Loop (HITL) Approval Layer for AI Agents
**Product, Technical & Go-to-Market Blueprint (Egypt → Global)**

---

## 1. Executive Summary & Core Wedge

Companies and AI automation agencies are actively deploying AI agents (via custom TypeScript/Python code, MCP servers, LangGraph, and n8n) to handle customer refunds, CRM updates, email outreach, and database actions. However, **teams refuse to let agents execute high-stakes actions unsupervised.**

While tools like n8n offer basic "send a Slack message and wait" nodes, DIY setups fail in production. This SaaS provides a dedicated **control and approval layer** that sits between any AI agent and sensitive real-world actions.

### The 4 Moats Beyond Basic Approve/Reject Buttons
1. **Edit-Before-Execute:** Reviewers can modify specific fields of an AI's proposed payload (e.g., changing a refund amount from `$500` to `$150` or editing two sentences of a drafted email) directly in a clean UI/Slack modal, then click **Approve & Resume**.
2. **Policy & Risk Routing Engine:** Define deterministic guardrails (e.g., auto-approve actions `< $50`, route `$50–$500` to a team lead, require dual sign-off with a 30-minute escalation timeout for `> $500`).
3. **Framework-Agnostic Central Inbox:** Aggregates approvals from n8n workflows, custom Node/Python agents, and MCP tool calls into one unified dashboard and branded client portal.
4. **Immutable Audit Trail:** Logs the original AI proposal, human edits (JSON diff), approver identity, timestamp, and final webhook delivery—ready for finance reviews and SOC2/ISO compliance.

---

## 2. Target Buyers & Go-to-Market Wedge

### Phase 1 (Months 1–4): AI Automation Agencies (Fastest Path to Revenue)
* **Profile:** 2–15 person automation studios building AI agents and n8n workflows for e-commerce, real estate, recruiting, and SaaS clients globally (US, UK, EU, GCC).
* **Core Pain:** Their clients are afraid to turn agents loose in production, which stalls retainers and forces agencies to manually babysit automations.
* **The Hook:** A **White-Label / Branded Client Approval Portal** (accessible via secure magic links—no Slack workspace required) that agencies hand to their clients so end-clients can review, edit, and approve AI actions in one click.
* **Unit Economics:** One agency managing 5–10 client workflows easily justifies a **$149–$249/mo** subscription because it directly helps them close $3,000+/mo client retainers.

### Phase 2 (Months 4–12): Engineering & Internal Ops Teams
* **Profile:** AI/Backend Engineers, Heads of Ops, and CTOs at 20–250 person SaaS, FinTech, and e-commerce companies.
* **Core Pain:** Scattered approval scripts, lack of timeout escalations, and zero audit visibility into what AI agents changed in production systems.
* **The Hook:** Drop-in TypeScript/Python SDK and **MCP Tool Wrapper** that adds policy rules, Slack Block Kit modals, and SOC2-ready audit logs in 5 minutes.

---

## 3. Pricing & Global Business Setup (Starting from Egypt)

Price for **global value (USD)**, never local cost benchmarks.

| Tier | Price (USD) | Target User | Included Limits & Features |
| :--- | :--- | :--- | :--- |
| **Free / Sandbox** | $0/mo | Solo devs & testing | 300 approvals/mo, 7-day audit log, 1 project, Slack & Web UI |
| **Pro** | $79/mo | Startups & solo builders | 5,000 approvals/mo, Edit-before-execute, Policy rules, 90-day audit log, SLA timeouts |
| **Agency / Team** | $249/mo | Automation agencies & scaling teams | 25,000 approvals/mo, **Branded Client Portals (magic links)**, Multi-step approvers, 1-year audit exports, RBAC |
| **Enterprise** | Custom ($750+/mo) | Regulated mid-market (US/EU/GCC) | Unlimited approvals, SSO/SAML, custom data retention, dedicated webhook IPs |

### Payments & Legal Staging
1. **Day 1 (Pre-Incorporation / Validation):** Use a **Merchant of Record (Paddle or Lemon Squeezy)** to handle global USD/EUR subscriptions, invoicing, and VAT/sales tax automatically.
2. **Post-Traction ($2k–$5k MRR):** Incorporate a lightweight global entity (e.g., **US Delaware/Wyoming LLC**, **UK Ltd**, or **UAE Free Zone**) to simplify enterprise vendor onboarding, Stripe direct access, and banking.

---

## 4. Technical Architecture

Keep the architecture boring, strictly typed, and engineered for reliability (missed webhooks or duplicate executions destroy trust immediately).

### Recommended Tech Stack
* **Frontend & Client Portal:** Next.js (App Router), TypeScript, Tailwind CSS
* **Backend API & Policy Worker:** NestJS (or Express/Fastify) + TypeScript
* **Primary Database:** PostgreSQL (with `JSONB` for flexible payloads, schemas, and diffs)
* **Queue, Timers & Retries:** Redis + BullMQ (delayed jobs for SLA timeouts/escalations; exponential backoff for webhook delivery)
* **Integrations:** Slack Bolt / Block Kit (interactive cards + edit modals), Resend/Postmark (email magic links)

### Core Execution State Machine

```text
[Agent POST /v1/approvals]
           │
           ▼
   (Evaluate Policies)
     ├── Matches Auto-Approve Rule ──► [AUTO_APPROVED] ──► Return 200 immediately
     └── Requires Human Review     ──► [PENDING]       ──► Enqueue BullMQ Timeout Job
                                           │               Notify Slack / Email Portal
                                           ▼
                                   (Human Decision)
             ┌─────────────────────────────┼─────────────────────────────┐
             ▼                             ▼                             ▼
        [APPROVED]              [EDITED_AND_APPROVED]               [REJECTED]
             │                             │                             │
             └─────────────────────────────┴─────────────────────────────┘
                                           │
                                           ▼
                         Cancel Timeout Job + Write Audit Log
                                           │
                                           ▼
                         Dispatch HMAC-Signed Webhook Callback
                           ├── 2xx Response ──► [DELIVERED]
                           └── Non-2xx      ──► Retry (BullMQ w/ backoff) ──► [DELIVERY_FAILED]

* If BullMQ Timeout Job fires while state == PENDING:
  └── Transition to [TIMED_OUT] ──► Escalate to backup reviewer OR fire fallback webhook.
```

### Key Reliability & Security Requirements
* **Idempotency:** Every `POST /v1/approvals` accepts an `Idempotency-Key` header so retrying agents never create duplicate approval cards.
* **Signed Webhooks:** Outgoing callbacks include an `X-Signature-256` header computed via `HMAC-SHA256(webhook_secret, timestamp + "." + raw_body)` to prevent spoofing.
* **Magic-Link Security:** External client review links use short-lived, single-action or scoped signed tokens stored hashed in the database, allowing non-technical clients to approve/edit without creating accounts.
* **JSON Schema Form Rendering:** Agents can optionally pass an `editable_fields` schema so the Web Portal and Slack Modal render clean, typed inputs (number, currency, multiline text, dropdown) instead of raw JSON.

---

## 5. PostgreSQL Database Schema

```sql
-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Organizations (Workspaces / Agencies)
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free', -- free | pro | agency | enterprise
    branding_config JSONB NOT NULL DEFAULT '{}'::jsonb, -- logo_url, accent_color, custom_domain
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Projects / Client Sub-Workspaces (Critical for Agencies)
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    webhook_secret TEXT NOT NULL, -- encrypted at rest; used for HMAC signing
    slack_workspace_id TEXT,
    slack_bot_token_enc TEXT, -- encrypted OAuth token
    default_slack_channel TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. API Keys (Scoped per project)
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_prefix TEXT NOT NULL, -- e.g., "hk_live_9a2b"
    key_hash TEXT NOT NULL UNIQUE, -- SHA-256 hash of full key
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Policy Rules (Risk-based routing & auto-approval)
CREATE TABLE policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    action_type TEXT NOT NULL, -- e.g., "stripe.refund", "email.send", "*"
    priority INT NOT NULL DEFAULT 100,
    -- Example conditions: {"field": "amount", "op": "gt", "value": 100}
    conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
    decision_mode TEXT NOT NULL, -- 'auto_approve' | 'require_approval' | 'auto_reject'
    required_approvals INT NOT NULL DEFAULT 1,
    timeout_seconds INT NOT NULL DEFAULT 3600,
    timeout_behavior TEXT NOT NULL DEFAULT 'reject', -- 'reject' | 'approve' | 'escalate'
    approver_emails TEXT[] NOT NULL DEFAULT '{}',
    slack_channel_override TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_policies_project_action ON policies(project_id, action_type, priority) WHERE is_active = TRUE;

-- 5. Approval Requests
CREATE TABLE approval_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    policy_id UUID REFERENCES policies(id) ON DELETE SET NULL,
    idempotency_key TEXT,
    action_type TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    agent_name TEXT,
    
    -- Payload & Edit-Before-Execute tracking
    original_payload JSONB NOT NULL,
    final_payload JSONB, -- Populated upon approval or edit-and-approve
    editable_schema JSONB, -- Optional field metadata for clean UI forms
    
    -- State Machine
    status TEXT NOT NULL DEFAULT 'pending', 
    -- pending | auto_approved | approved | edited_and_approved | rejected | timed_out
    
    -- Delivery & Notifications
    callback_url TEXT,
    slack_message_ts TEXT,
    slack_channel_id TEXT,
    magic_token_hash TEXT UNIQUE, -- For external client review link
    
    -- Timestamps & Reviewer Info
    expires_at TIMESTAMPTZ,
    decided_by_name TEXT,
    decided_by_email TEXT,
    decision_note TEXT,
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    UNIQUE (project_id, idempotency_key)
);

CREATE INDEX idx_requests_project_status ON approval_requests(project_id, status, created_at DESC);

-- 6. Immutable Audit Logs (Append-only)
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    approval_request_id UUID NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL, -- created | policy_matched | viewed | edited | approved | rejected | timed_out | webhook_sent
    actor_type TEXT NOT NULL, -- agent | human | system
    actor_identifier TEXT NOT NULL, -- email, slack_user_id, or api_key_prefix
    diff_payload JSONB, -- RFC 6902 JSON patch or before/after snapshot
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb, -- IP address, user agent, slack channel
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_request ON audit_logs(approval_request_id, created_at ASC);

-- 7. Webhook Deliveries (Retry visibility)
CREATE TABLE webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    approval_request_id UUID NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
    callback_url TEXT NOT NULL,
    attempt_number INT NOT NULL DEFAULT 1,
    http_status INT,
    response_body TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | succeeded | failed
    next_retry_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 6. REST API, Webhook & SDK Contracts

### A. Create Approval Request
`POST /v1/approvals`  
Headers:
* `Authorization: Bearer hk_live_...`
* `Idempotency-Key: refund_ord_98421`

**Request Body:**
```json
{
  "action_type": "stripe.refund",
  "title": "Issue Refund for Order #98421",
  "summary": "Customer reported damaged item on delivery. Agent verified tracking photo.",
  "agent_name": "support-triage-agent-v2",
  "callback_url": "https://api.customer.com/webhooks/hitl-resume",
  "timeout_seconds": 1800,
  "payload": {
    "order_id": "ord_98421",
    "customer_email": "sarah@example.com",
    "refund_amount_usd": 240.00,
    "reply_message": "Hi Sarah, we have issued a full refund of $240 for your order."
  },
  "editable_schema": {
    "refund_amount_usd": { "type": "number", "label": "Refund Amount (USD)", "editable": true },
    "reply_message": { "type": "textarea", "label": "Customer Reply", "editable": true },
    "order_id": { "type": "string", "label": "Order ID", "editable": false }
  }
}
```

**Response (`202 Accepted` when human review is required):**
```json
{
  "id": "req_01J9X8K2M4N5P6Q7R8S9",
  "status": "pending",
  "review_url": "https://app.yourdomain.com/review/tkn_7f9a8b2c...",
  "expires_at": "2026-11-21T20:15:00Z"
}
```
*(If a policy auto-approves the action, the API returns `200 OK` with `"status": "auto_approved"` and `"final_payload"` immediately so the agent never pauses.)*

### B. Signed Webhook Callback (Sent to Agent on Decision)
Headers:
* `X-HITL-Timestamp: 1763756100`
* `X-Signature-256: sha256=e3b0c44298fc1c149afbf4c8996fb924...`

```json
{
  "event": "approval.edited_and_approved",
  "request_id": "req_01J9X8K2M4N5P6Q7R8S9",
  "action_type": "stripe.refund",
  "status": "edited_and_approved",
  "decided_by": {
    "name": "Alex Rivera",
    "email": "alex@acme.com"
  },
  "decision_note": "Approved partial refund per 30-day policy.",
  "original_payload": {
    "order_id": "ord_98421",
    "refund_amount_usd": 240.00,
    "reply_message": "Hi Sarah, we have issued a full refund of $240 for your order."
  },
  "final_payload": {
    "order_id": "ord_98421",
    "refund_amount_usd": 120.00,
    "reply_message": "Hi Sarah, we have issued a 50% partial refund of $120 for your order."
  },
  "decided_at": "2026-11-21T19:52:10Z"
}
```

### C. TypeScript SDK Developer Experience (Target DX)
```typescript
import { AgentGate } from '@agentgate/sdk';

const gate = new AgentGate({ apiKey: process.env.AGENTGATE_API_KEY });

// Option 1: Async Webhook Pattern (Best for production serverless / n8n)
await gate.requestApproval({
  actionType: 'stripe.refund',
  title: 'Refund Order #98421',
  payload: { orderId: 'ord_98421', amount: 240 },
  callbackUrl: 'https://my-app.com/api/resume-refund',
  idempotencyKey: 'refund_ord_98421',
});

// Option 2: Blocking Await Pattern (Best for local agents, scripts & MCP tools)
const decision = await gate.requestAndWait({
  actionType: 'email.send',
  title: 'Send Enterprise Proposal to Acme Corp',
  payload: { to: 'cto@acme.com', body: draftedEmail },
  timeoutMs: 15 * 60 * 1000,
});

if (decision.isApproved) {
  // Always execute using finalPayload so human edits are respected
  await sendEmail(decision.finalPayload);
}
```

---

## 7. Three Organic Distribution Surfaces

Code alone won't drive traffic. Ship three lightweight open-source adapters on GitHub to capture high-intent builders:

1. **n8n Community Node (`n8n-nodes-agentgate`):** Uses n8n's built-in Wait/Webhook resume mechanism. Users drop one node into their workflow, map the fields they want their client to be able to edit, and get an instant branded approval link + Slack button.
2. **MCP Tool Approval Middleware (`@agentgate/mcp`):** A 3-line wrapper around Model Context Protocol tool handlers (`wrapToolWithApproval(tool, { policy })`) so developers using Claude, Cursor, or custom MCP agents can protect destructive tools instantly.
3. **TypeScript & Python SDKs:** Published on npm and PyPI with a 5-minute quickstart and interactive sandbox.

---

## 8. 6-Week Solo Build & Validation Roadmap

Run engineering and customer validation **in parallel** every single week.

| Week | Engineering Milestones | Validation & Distribution Actions |
| :--- | :--- | :--- |
| **Week 1** | Finalize API spec, PostgreSQL schema, and clickable Next.js prototype of the **Review Queue + Edit-Before-Execute form**. | Reach out to 25 AI automation agency founders & AI engineers (LinkedIn, X, n8n forums). Book 8–10 quick discovery chats. |
| **Week 2** | Build core NestJS API (`POST/GET /v1/approvals`), API key auth, idempotency, policy rule evaluator, and BullMQ timeout/webhook workers. | Recruit 3–5 **Design Partners** from Week 1 calls. Offer 3 months free in exchange for wiring 1 live workflow into staging. |
| **Week 3** | Implement Slack OAuth, interactive Block Kit approval cards, and the **Slack Edit Modal** (so reviewers can tweak values without leaving Slack). | Record a 60-second Loom/X demo: AI agent proposes a `$500` Stripe refund → pauses → human edits to `$150` in Slack → agent resumes. |
| **Week 4** | Build the **Hosted Client Approval Portal** (magic links, custom agency logo/accent color, visual diff viewer) + TypeScript SDK. | Open-source the **n8n Community Node** and **MCP Wrapper** on GitHub; share tutorials in `r/n8n` and n8n Discord. |
| **Week 5** | Build immutable Audit Log UI, CSV/JSON export, retry inspector for failed webhooks, and integrate Paddle / Lemon Squeezy billing. | Move design partners from staging to production; fix real-world payload formatting edge cases and Slack token refresh bugs. |
| **Week 6** | Polish docs ("First approval in 5 minutes"), interactive no-signup sandbox on landing page, and security overview page. | Public launch on **Hacker News (`Show HN`)**, X, LinkedIn, `r/AI_Agents`, and `r/n8n`. Convert design partners & early signups to **$79–$249/mo**. |

---

## 9. 10-Day Validation Playbook & Outreach Scripts

Do not write full production infrastructure before validating willingness to pay. Aim for **at least 3 design partners** (or 2 pre-paid pilots at $49–$79/mo) during Week 1–2.

### Script 1: Cold DM for AI Automation Agency Founders (LinkedIn / X)
> Hey [Name] — saw you're building AI workflows / n8n agents for [their niche, e.g., e-commerce / real estate] clients.
>
> Quick question from another engineer: when a client is nervous about letting an AI agent send emails, update CRMs, or trigger refunds automatically, how are you handling human approvals right now?
>
> I'm building a lightweight white-label approval portal where clients get a one-click link (or Slack card) to **edit** what the AI drafted and hit "Approve & Resume" — with a full audit log. Happy to share a 60-second mockup if this is a bottleneck for your client handoffs.

### Script 2: Cold Message for AI / Backend Engineers (Slack / Discord / LinkedIn)
> Hey [Name] — I saw your post about shipping [AI agent / MCP workflow]. Curious how your team handles guardrails for risky tool calls (like DB writes, refunds, or outbound messages) without building a custom internal admin panel from scratch?
>
> I'm building an API-first human-in-the-loop approval layer (policy rules + edit-before-execute + Slack modals + audit trail). Would love 10 minutes to hear what breaks in your current setup—not pitching anything, just trying to make sure we don't miss real edge cases.

### 5 Discovery Call Questions (Listen More Than You Pitch)
1. *"Walk me through the last time an AI workflow or agent did something embarrassing or risky—what happened?"*
2. *"Which specific actions do your clients/managers still refuse to automate fully?"*
3. *"How are you handling approvals today (Slack hack, email, manual spreadsheet, or just turning the agent off)?"*
4. *"When a human reviews an AI action, how often do they want to tweak a field vs. reject the whole thing?"*
5. *"If we set this up with your logo for one client workflow next week, what would it need to do for you to happily pay $149/mo for it?"*

### Go / No-Go Gate (End of Week 2)
* **Green Light:** 3+ teams/agencies agree to plug in a real workflow and explicitly ask for features like white-labeling, custom policies, or audit exports.
* **Pivot Signal:** Everyone says *"n8n's basic Slack wait node is good enough for us"* and nobody cares about edit-before-execute, client portals, or audit logs. If so, pivot to **Idea #2 (Contractor Access Expiry Tracker)** before burning Week 3–6 engineering time.