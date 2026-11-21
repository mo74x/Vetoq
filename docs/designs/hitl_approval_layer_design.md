# HITL Approval Layer (v1: n8n + Magic-Link Portal)

*   **Author:** Mohamed Arafa (Mo74x)
*   **Status:** Proposed
*   **Date:** 2026-11-21

--------------------------------------------------------------------------------

## Overview

This document specifies the v1 architecture and implementation plan for a Human-in-the-Loop (HITL) approval service aimed at AI automation agencies running client workflows (starting with n8n). The system sits between an automated workflow and high-stakes external actions (such as refunds, outbound emails, or CRM writes), evaluates deterministic policy rules, pauses execution when human review is needed, and resumes the workflow via an HMAC-signed webhook after a human approves, edits, or rejects the proposed payload.

## The Problem

AI automation agencies can build workflows in n8n or custom scripts, but their end-clients refuse to let agents execute financial or customer-facing actions unsupervised. Existing workarounds break down in production:

1.  **No Edit-Before-Execute:** Native n8n Slack/email wait nodes only support binary approve/reject. Reviewers cannot adjust a refund amount or edit a drafted email before execution without manually intervening outside the workflow.
2.  **Brittle Magic Links & Unattributed Approvals:** Custom webhook links sent over email are pre-fetched by security scanners (Defender Safe Links, Mimecast, Proofpoint) and lack per-approver tokens or multi-approver quorum tracking.
3.  **No Policy Guardrails or Audit Trail:** DIY approval scripts lack deterministic risk routing, fail-closed timeout handling, and an append-only record of what the AI proposed versus what the human approved.

## Goals

*   **Zero-Install n8n Integration:** Work on both n8n Cloud and self-hosted n8n at v1 launch using importable native `HTTP Request` + `IF` + `Wait` + HMAC verification templates (no unverified community npm node required).
*   **Anti-Prefetch Magic-Link Portal:** Provide a strictly read-only `GET` review page with hosted agency branding (`logo_url`, `accent_color`, path-based `/p/:orgSlug/review/:token`) and `POST`-only decision submission protected by a stateless HMAC-signed `action_nonce`.
*   **Validated Edit-Before-Execute:** Render typed forms from `editable_schema`, enforce field mutability and bounds (`min`/`max`/`maxLength`) on the server, compute RFC 6902 JSON diffs, and re-run policy evaluation on `final_payload` before resuming.
*   **Multi-Approver Consensus:** Track per-approver votes bound to `payload_version` in `approval_votes` and reset prior approvals if any reviewer edits the payload (capped at 3 edit rounds) so all required approvers approve the identical `final_payload`.
*   **Fail-Closed Execution & Append-Only Audit:** Default unmatched policies, parse errors, and timeouts to rejection (never silent approval), guarantee webhook/timeout delivery via PostgreSQL reconciliation, and enforce immutability on `audit_logs` at the PostgreSQL level.

## Non-Goals

*   **Slack OAuth & Block Kit Edit Modals (Deferred to Phase 2):** v1 routes reviews through the magic-link web portal and email notifications.
*   **TypeScript/Python SDKs & MCP Middleware (Deferred to Phase 2):** Blocking `requestAndWait` polling and MCP tool wrappers are out of scope for v1.
*   **Verified n8n Community Node (Deferred to Phase 1.5/2):** v1 uses native n8n HTTP + IF + Wait workflow JSON templates.
*   **Custom Agency Domains & Custom SMTP (Deferred to Phase 2):** v1 uses hosted path branding (`/p/:orgSlug/...`) and `Reply-To` headers rather than per-agency TLS/DNS provisioning.
*   **Automated Billing Webhooks (Deferred to Phase 2):** Early agency plans are managed manually via `organizations.plan`; Paddle/Polar webhook automation is out of scope for v1.
*   **Email OTP Step-Up Verification (Deferred to Phase 2):** v1 relies on per-approver capability tokens and single-use HMAC `action_nonce` on `POST`.
*   **Timeout Escalation & Fail-Open Timeouts (`timeout_behavior = 'escalate' | 'approve'`):** Excluded from v1; all timeouts transition to `timed_out` (fail-closed).

## Critical User Journeys (CUJs)

### CUJ 1: Single-Approver Edit-Before-Execute via n8n

*   **Given**: An agency has configured a project, a policy requiring 1 approval for `stripe.refund` over `$50`, and an n8n workflow using the v1 HTTP + IF + Wait template.
*   **When**: The n8n workflow calls `POST /v1/approvals` with a `$240` refund payload and `editable_schema`. The API returns `202 Accepted` (`status: "pending"`), so n8n enters the `Wait` node. The end-client opens the emailed magic link (`GET /p/:orgSlug/review/:token`), changes `refund_amount_usd` to `120`, and clicks **Approve with Edits**.
*   **Then**: The server validates the edit against `editable_schema`, re-runs policy evaluation, records `edited_and_approved` and the JSON diff in `audit_logs`, inserts a `pending` row in `webhook_deliveries` inside the same transaction, cancels the BullMQ timeout job, and dispatches an HMAC-signed webhook to the n8n Wait resume URL containing `final_payload`.

### CUJ 2: Multi-Approver Consensus with Edit Reset

*   **Given**: A policy requires `required_approvals = 2` for `stripe.refund` over `$500`, with two approver emails configured.
*   **When**: Approver A submits an `approve` vote on `payload_version = 1`, and then Approver B edits `refund_amount_usd` from `$600` to `$550` and submits an `approve` vote.
*   **Then**: `payload_version` increments to `2`, Approver A's prior `approve` vote is marked `superseded_at = NOW()`, the request remains `pending` with 1 valid vote (Approver B's on `payload_version = 2`), and Approver A is re-notified to re-confirm `payload_version = 2` using their magic link before the webhook fires.

### CUJ 3: Fail-Closed Timeout & Permanent Webhook Failure Handling

*   **Given**: An approval request is `pending` with `timeout_seconds = 1800`.
*   **When**: No human decides before `expires_at`, so the BullMQ timeout worker (or periodic PostgreSQL reconciliation sweep) fires.
*   **Then**: The worker atomically transitions the request from `pending` to `timed_out` (using row locking so a simultaneous human click cannot race), writes a `timed_out` audit event, inserts a `pending` `webhook_deliveries` row in the same transaction, and fires the signed webhook with `status: "timed_out"`. If the n8n Wait URL returns `400`/`404`/`410`, the worker marks `delivery_status = "delivery_failed"` without further retries.

## Technical Plan (Architecture)

### 1. Monorepo & Deployment Topology

The system is a TypeScript monorepo managed with **Turborepo + pnpm** (`engines.node >= 20.19.0`, workspace scope `@hitl/*`):

*   `apps/web` (`@hitl/web`, **Next.js 16 + Tailwind CSS + shadcn/ui**, hosted on Vercel): Serves the agency admin dashboard (Better Auth sessions), approval queue, webhook retry inspector, audit log viewer, and read-only branded magic-link review pages (`/p/:orgSlug/review/:token`). Proxies `/api/auth/*` to `${API_INTERNAL_URL}/api/auth/*` and `/api/v1/:path*` to `${API_INTERNAL_URL}/v1/:path*` (falling back to `http://localhost:3001` at build time) via Next.js rewrites so browser requests share a single origin (`BETTER_AUTH_URL` / `WEB_URL`) and avoid third-party cookie blocking.
*   `apps/api` (`@hitl/api`, **NestJS 12 + Zod + BullMQ**, hosted on Railway or Hetzner/Coolify): Serves `/api/auth/*` (Better Auth), `/v1/approvals`, `/v1/review/:token/*`, and `/v1/dashboard/*`; runs BullMQ workers for SLA timeouts, webhook delivery retries, Resend email dispatch, and a 15-second PostgreSQL reconciliation sweep.
*   `packages/shared` (`@hitl/shared`): Pure TypeScript (browser-safe, no `node:dns` imports) Zod request/response schemas, `editable_schema` validator, RFC 6902 diffing (`fast-json-patch`), policy evaluation engine, and IP/CIDR validation (`ipaddr.js`).
*   `packages/db` (`@hitl/db`): Drizzle ORM schema, SQL migrations (including `audit_logs` immutability trigger), and PostgreSQL client.

```text
+-------------------+        POST /v1/approvals         +-----------------------------+
|  n8n Workflow     | --------------------------------> | apps/api (NestJS 12 + Zod)  |
|  (HTTP+IF+Wait)   | <-------------------------------- |  - Better Auth (/api/auth/*)|
+-------------------+   Signed Webhook (X-Signature-256)|  - Policy Engine + Workers  |
                                                        +--------------+--------------+
                                                                       ^
                                                        Next.js Rewrite (/api/v1/*, /api/auth/*)
                                                                       |
+-------------------+   GET /p/:orgSlug/review/:token   +--------------+--------------+
|  End-Client /     | --------------------------------> | apps/web (Next.js 16)       |
|  Agency Browser   |   POST /api/v1/review/:t/decide   |  - Read-only Review UI      |
|                   | --------------------------------> |  - Agency Admin Dashboard   |
+-------------------+          (same origin)            +-----------------------------+
```

### 2. PostgreSQL Data Model (Drizzle ORM)

All tables live in PostgreSQL (`packages/db`):

*   **Auth & Tenancy (Better Auth with `usePlural: true` + `organization` plugin):** `users`, `sessions`, `accounts`, `verifications`, `organizations` (extended with `plan TEXT DEFAULT 'free'`, `branding_config JSONB DEFAULT '{}'`), `members`, `invitations`.
*   **`projects`:** `id`, `org_id`, `name`, `default_approver_emails TEXT[] NOT NULL DEFAULT '{}'`, `webhook_secret_enc` (versioned AES-256-GCM `v1:<iv>:<tag>:<ciphertext>`), `webhook_secret_prev_enc` (nullable for dual-key secret rotation without invalidating in-flight webhooks), `deleted_at` (soft delete).
*   **`api_keys`:** `id`, `project_id`, `name`, `key_prefix`, `key_hash UNIQUE`, `last_used_at`, `revoked_at`.
*   **`policies`:** `id`, `project_id`, `action_type`, `priority`, `conditions JSONB`, `decision_mode` (`auto_approve | require_approval | auto_reject`), `required_approvals` (`INT DEFAULT 1`), `timeout_seconds` (`INT DEFAULT 3600`), `timeout_behavior` (`'reject'` only in v1), `approver_emails TEXT[]`, `is_active`.
*   **`approval_requests`:**
    *   `id`, `project_id`, `policy_id` (`ON DELETE SET NULL`), `initial_policy_snapshot JSONB NOT NULL` (immutable creation-time snapshot), `effective_policy_snapshot JSONB NOT NULL` (updated only if an edit triggers a stricter policy).
    *   `idempotency_key`, `idempotency_request_hash` (`UNIQUE(project_id, idempotency_key)`).
    *   `action_type`, `title`, `summary`, `agent_name`, `original_payload JSONB`, `final_payload JSONB`, `editable_schema JSONB`.
    *   `required_approvals INT NOT NULL DEFAULT 1`, `payload_version INT NOT NULL DEFAULT 1`, `edit_count INT NOT NULL DEFAULT 0`.
    *   Separated state fields: `status` (`pending | auto_approved | auto_rejected | approved | edited_and_approved | rejected | timed_out`) and `delivery_status` (`not_applicable | pending | delivered | delivery_failed`).
    *   `callback_url`, `expires_at`, `decided_at`, `deleted_at`.
*   **`approval_tokens`:** `id`, `approval_request_id`, `approver_email`, `token_hash UNIQUE`, `expires_at`, `revoked_at`, `used_at` (set only when `approval_requests` reaches a terminal status, allowing re-confirmation on edit resets).
*   **`approval_votes`:** `id`, `approval_request_id`, `approver_email`, `approver_name`, `payload_version INT NOT NULL`, `decision` (`approve | reject`), `edited_payload JSONB`, `note`, `superseded_at` (nullable), `created_at`. Partial unique index on `(approval_request_id, approver_email, payload_version) WHERE superseded_at IS NULL`.
*   **`audit_logs`:** `id`, `project_id` (`ON DELETE RESTRICT`), `approval_request_id` (`ON DELETE RESTRICT`), `event_type` (`created | policy_matched | policy_escalated | viewed | edited | vote_recorded | votes_superseded | approved | rejected | auto_approved | auto_rejected | timed_out | webhook_enqueued | webhook_succeeded | webhook_failed`), `actor_type` (`agent | human | system`), `actor_identifier`, `diff_payload JSONB`, `metadata JSONB`, `created_at`. Protected by a PostgreSQL `BEFORE UPDATE OR DELETE` trigger that raises an exception.
*   **`webhook_deliveries`:** `id`, `approval_request_id`, `callback_url`, `attempt_number`, `http_status`, `response_body` (truncated to 4 KB), `status` (`pending | succeeded | failed`), `next_retry_at`, `created_at`.

### 3. Core JSON Contracts & DSLs

1.  **`policies.conditions` DSL:** Flat array of AND-ed predicates:
    ```json
    [
      { "field": "refund_amount_usd", "op": "gt", "value": 50 },
      { "field": "customer.tier", "op": "in", "value": ["enterprise", "vip"] }
    ]
    ```
    Supported `op` values: `eq | neq | gt | gte | lt | lte | in | contains`. Dot-paths resolve nested payload keys safely (blocking `__proto__`/`constructor`/`prototype`). Missing fields or type mismatches fail closed to `require_approval`.
2.  **`editable_schema` Contract:** Flat map keyed by top-level payload field name:
    ```json
    {
      "refund_amount_usd": { "type": "number", "label": "Refund Amount (USD)", "editable": true, "min": 0, "max": 500 },
      "reply_message": { "type": "textarea", "label": "Customer Reply", "editable": true, "maxLength": 2000 },
      "order_id": { "type": "string", "label": "Order ID", "editable": false }
    }
    ```
    Supported `type` values: `string | textarea | number | boolean | enum` (with `options: string[]` required for `enum`).
3.  **`POST /v1/approvals` Request & Response:**
    *   Headers: `Authorization: Bearer hk_live_...`, optional `Idempotency-Key` (max 128 chars).
    *   Body (max 64 KB): `{ action_type, title, summary?, agent_name?, callback_url, timeout_seconds?, payload, editable_schema? }`.
    *   Responses:
        *   If `decision_mode === 'auto_approve'` or `'auto_reject'`: persist `approval_requests` (`status: 'auto_approved' | 'auto_rejected'`, `delivery_status: 'not_applicable'`) + `audit_logs`, do **not** enqueue a webhook, and return `200 OK` with `{ id, status, final_payload }`.
        *   If `decision_mode === 'require_approval'`: return `202 Accepted` with `{ id, status: 'pending', expires_at }`.
4.  **`POST /v1/review/:token/decide` (`SubmitDecisionRequest`):**
    *   Body: `{ action_nonce: string, payload_version: number, decision: 'approve' | 'reject', approver_name?: string, edited_fields?: Record<string, unknown>, note?: string }`. (`approver_name` defaults to `approver_email` if omitted.)
    *   If `decision === 'reject'` and `edited_fields` is non-empty, return `400 Bad Request`. If `payload_version` does not match the current `approval_requests.payload_version`, return `409 Conflict`.
5.  **`WebhookCallbackPayload` & Signing:**
    *   Body: `{ event: 'approval.approved' | 'approval.edited_and_approved' | 'approval.rejected' | 'approval.timed_out', request_id, action_type, status, decided_by?: { name, email }, decision_note?, original_payload, final_payload, decided_at }`.
    *   Headers: `X-HITL-Timestamp` (Unix seconds), `X-Signature-256: sha256=<hex>` computed as `HMAC-SHA256(webhook_secret, "${timestamp}.${rawBody}")`.

### 4. Core Flows & Reliability Invariants

1.  **Request Ingestion (`POST /v1/approvals`):**
    *   Authenticate Bearer API key (`key_hash`), validate payload with Zod (<= 64 KB), and validate `callback_url` syntax and literal IPs against private/loopback/link-local CIDRs synchronously (DNS resolution runs in the async webhook worker to keep p95 latency low).
    *   Check `(project_id, idempotency_key)`: if present and `idempotency_request_hash` matches, return cached response; if hash differs, return `409 Conflict`.
    *   Evaluate active policies ordered by `priority ASC` (first match wins). If no policy matches or a condition fails to parse, fail closed to `require_approval` (`required_approvals = 1`, `timeout_behavior = 'reject'`), resolving approver recipients from `projects.default_approver_emails` (or falling back to organization `owner`/`admin` emails from `members` joined with `users` if empty).
    *   For `require_approval`, create `approval_requests` and per-approver `approval_tokens` in PostgreSQL, enqueue a BullMQ delayed timeout job with deterministic `jobId: "timeout:${approvalRequestId}"`, and enqueue Resend email jobs.
2.  **Stateless Anti-Prefetch Magic-Link Decision:**
    *   `GET /v1/review/:token` is **100% read-only** (zero DB writes). It returns request metadata, `payload_version`, `editable_schema`, branding config, and a short-lived (15 min) stateless HMAC-SHA256 signed `action_nonce` encoding `{ token_id, payload_version, jti, exp }`. Post-load email scanner prefetches or multiple browser tabs cannot invalidate an active nonce. `viewed` audit events are sent via an explicit client-side beacon (`POST /v1/review/:token/viewed`) after hydration.
    *   `POST /v1/review/:token/decide` (rate-limited per IP and per token) verifies `token_hash`, validates the HMAC signature + expiry of `action_nonce`, and atomically marks `jti` as spent in Redis (`SET nonce:<jti> 1 EX 900 NX`).
    *   Inside a PostgreSQL transaction with `SELECT ... FOR UPDATE` on `approval_requests`:
        *   Reject with `409 Conflict` if `status !== 'pending'` or `payload_version` is stale.
        *   If `edited_fields` are provided: reject with `400` if `edit_count >= 3`; validate against `editable_schema`, compute `final_payload` and RFC 6902 `diff_payload`, and re-run policy evaluation on `final_payload`.
            *   If re-evaluation matches `auto_reject`, transition immediately to `status = 'rejected'`.
            *   Otherwise enforce monotonic safety: `required_approvals = max(current, matched.required_approvals)` (never downgrading a pending human review to `auto_approved`), update `effective_policy_snapshot` (keeping `initial_policy_snapshot` immutable), increment `payload_version` and `edit_count`, mark prior active `approval_votes` as `superseded_at = NOW()`, and enqueue re-notification emails.
        *   Insert the vote in `approval_votes`. If active `approve` votes for the current `payload_version` reach `required_approvals` (or if `decision === 'reject'`), transition `status`, set `delivery_status = 'pending'`, mark `approval_tokens.used_at = NOW()`, write `audit_logs`, and **insert the initial `pending` row into `webhook_deliveries` in the same transaction** (transactional outbox).
        *   After commit, cancel `timeout:${approvalRequestId}` in BullMQ and enqueue the webhook delivery job.
3.  **Webhook Delivery, Timeout, & Reconciliation Workers (BullMQ):**
    *   `timeout.processor.ts`: Acquires `SELECT ... FOR UPDATE` on `approval_requests`; if still `pending`, transitions to `timed_out`, writes `audit_logs`, inserts a `pending` `webhook_deliveries` row in the same transaction, and enqueues webhook delivery.
    *   `reconciliation.processor.ts`: Runs every 15 seconds to recover from Redis/process crashes by enqueuing any `pending` `approval_requests` past `expires_at` and any `pending` `webhook_deliveries` older than 10 seconds without an active job.
    *   `webhook.processor.ts`: Resolves DNS, validates the resolved IP against private/loopback/link-local CIDRs, pins the validated IP in a custom HTTP agent `lookup` hook (preventing DNS-rebinding TOCTOU), disables HTTP redirects (`redirect: 'manual'`, rejecting `3xx`), uses a 10-second request timeout, and truncates stored `response_body` to 4 KB. Stops retrying immediately on `400`/`404`/`410`; retries `429`/`5xx`/timeouts up to 5 times with exponential backoff (10s base).
4.  **Zero-Install n8n Template Pack:**
    *   Importable n8n workflow JSON: `HTTP Request` (`POST /v1/approvals` passing `$execution.resumeUrl` as `callback_url`) → **`IF` node (`status === 'pending'`)** → `Wait (On Webhook Call)` → `Code` node verifying `X-Signature-256` (`crypto.timingSafeEqual` + `<= 300s` `X-HITL-Timestamp` skew against `webhook_secret` / `webhook_secret_prev`) before executing downstream actions using `final_payload`. Synchronous `auto_approved` responses bypass `Wait` directly; `auto_rejected` stops the branch.

## Alternatives Considered

### Alternative A: Build for Agencies and Software Engineers Simultaneously

*   **Pros**: Addresses both white-label client approvals and developer SDK/MCP use cases at v1 launch.
*   **Cons**: Splits a solo builder across a branded web portal, Slack OAuth/Block Kit modals, TypeScript/Python SDKs (`requestAndWait`), MCP middleware, and an n8n node in 6 weeks.
*   **Reason for Rejection**: Building both the agency portal and developer SDKs simultaneously delays the core approval state machine and slows validation with agencies.

### Alternative B: Lead with `n8n-nodes-agentgate` Community Node at v1 Launch

*   **Pros**: Consolidates three native nodes into one custom node on the n8n canvas.
*   **Cons**: n8n Cloud blocks unverified community npm nodes, excluding n8n Cloud agencies from v1 onboarding and adding npm publishing/maintenance overhead before validation.
*   **Reason for Rejection**: Importable native `HTTP Request` + `IF` + `Wait` + `Code` workflow JSON templates work immediately on both n8n Cloud and self-hosted instances.

### Alternative C: Lock the Magic-Link Client Portal Behind the $249/mo Agency Tier

*   **Pros**: Reserves the magic-link client portal for the highest self-serve pricing tier.
*   **Cons**: Agencies cannot test the end-client magic-link experience in Free or Pro before committing to $249/mo.
*   **Reason for Rejection**: Agencies need to experience the magic-link portal during onboarding; pricing should gate active client projects, custom branding, and monthly approval volume instead.

### Alternative D: Separate Backend and Frontend Repositories

*   **Pros**: Independent CI pipelines and zero coupling between NestJS and Next.js builds.
*   **Cons**: Requires duplicating or publishing Zod schemas, `editable_schema` validators, and Drizzle types across repos, slowing down TypeScript refactoring.
*   **Reason for Rejection**: A single Turborepo + pnpm monorepo keeps `apps/web`, `apps/api`, `packages/shared`, and `packages/db` strictly typed end-to-end.

### Alternative E: Single `magic_token_hash` Column and Fail-Open Timeouts

*   **Pros**: Simpler initial schema with two fewer tables (`approval_tokens`, `approval_votes`).
*   **Cons**: Cannot attribute votes in multi-approver policies, cannot revoke individual approver links, leaves `GET` links vulnerable to email scanner pre-fetches, and `timeout_behavior = 'approve'` risks executing unreviewed high-stakes actions.
*   **Reason for Rejection**: Multi-approver consensus and auditability require per-approver capability tokens, vote tracking, and fail-closed timeouts.

## Non-Functional Requirements

*   **Security & Privacy**:
    *   API keys (`hk_live_...`) and magic tokens are stored only as SHA-256 hashes; project `webhook_secret` values are encrypted at rest with versioned AES-256-GCM (`APP_ENCRYPTION_KEY`, `v1:...`) and support dual-key secret rotation without invalidating in-flight webhooks via `webhook_secret_prev_enc`.
    *   SSRF protection blocks private, loopback, and link-local IP ranges synchronously on literal URLs and immediately after DNS resolution (with IP pinning and `redirect: 'manual'`) before connecting in the BullMQ webhook worker.
    *   Public review endpoints enforce per-IP and per-token rate limiting.
    *   `audit_logs` is protected by `ON DELETE RESTRICT` and a PostgreSQL `BEFORE UPDATE OR DELETE` trigger (tenant PII anonymization on offboarding is deferred to Phase 2).
*   **Performance & Latency**:
    *   `POST /v1/approvals` targets `< 150 ms` p95 response time (policy evaluation + DB insert + BullMQ enqueue; Resend email dispatch runs asynchronously via BullMQ so SMTP/email API latency does not block the HTTP response).
*   **Rollout & Migrations**:
    *   Database schema changes are managed via forward-only Drizzle SQL migrations tracked in `packages/db/drizzle/meta/_journal.json`.
    *   Because no legacy production data exists yet, v1 launches directly behind API key project isolation; Phase 2 features (Slack, SDKs, MCP, billing webhooks) will be gated per-project.

## Detailed Implementation Plan

All files live inside a single Turborepo + pnpm monorepo at the repository root using workspace scope `@hitl/*`.

### Required Environment Variables (`.env.example`)
*   `DATABASE_URL`, `REDIS_URL`, `APP_ENCRYPTION_KEY` (32-byte hex), `ACTION_NONCE_SECRET` (32-byte hex), `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (public `apps/web` origin), `WEB_URL` (public `apps/web` origin for magic-link emails and Better Auth `trustedOrigins`), `RESEND_API_KEY`, `EMAIL_FROM`, `API_INTERNAL_URL` (used by Next.js rewrites in `apps/web`).

### Target Files to Create/Modify

#### 1. Root & Workspace Configs (Create)
*   **Files:** `package.json` (`engines.node >= 20.19.0`), `pnpm-workspace.yaml`, `turbo.json` (pipelines: `build`, `lint`, `test`, `test:e2e`, `typecheck`, `db:migrate`), `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc`, `.env.example`, `docker-compose.yml` (PostgreSQL 16 + Redis 7), plus workspace manifests `packages/shared/package.json` (`@hitl/shared`), `packages/db/package.json` (`@hitl/db`), `apps/api/package.json` (`@hitl/api`), `apps/web/package.json` (`@hitl/web`) and their per-package `tsconfig.json` files (using Node `>= 20.19.0` `require(esm)` compatibility for NestJS 12).
*   **Rationale**: Coordinates TypeScript builds, linting, Drizzle migrations, local/CI containers, and pnpm workspace filtering across all packages.

#### 2. `packages/shared/src/schemas.ts`, `policy-evaluator.ts`, `editable-schema.ts`, `ssrf.ts`, `index.ts` (Create)
*   **Type / Scope**: Shared Domain & Validation Library (`@hitl/shared`, dependencies: `zod`, `fast-json-patch`, `ipaddr.js`)
*   **Proposed Changes**:
    *   `schemas.ts`: Zod schemas for `PolicyCondition`, `EditableSchema`, `CreateApprovalRequest`, `SubmitDecisionRequest`, and `WebhookCallbackPayload` matching Section 3 contracts.
    *   `policy-evaluator.ts`: Deterministic `priority ASC` first-match evaluator supporting `eq|neq|gt|gte|lt|lte|in|contains` with safe dot-path traversal and fail-closed default (`require_approval`).
    *   `editable-schema.ts`: Enforces `editable: true`, types, `min`/`max`/`maxLength`/`options`, and generates RFC 6902 diffs via `fast-json-patch`.
    *   `ssrf.ts`: Browser-safe URL syntax and IPv4/IPv6 CIDR validator using `ipaddr.js` (no `node:dns` imports so `apps/web` can safely import `@hitl/shared`).
*   **Rationale**: Centralizing validation and policy logic prevents schema drift between `apps/api` and `apps/web`.

#### 3. `packages/shared/vitest.config.ts`, `packages/shared/src/__tests__/policy-evaluator.spec.ts`, `editable-schema.spec.ts`, `ssrf.spec.ts` (Create)
*   **Type / Scope**: Unit Tests
*   **Proposed Changes**: Cover fail-closed policy misses, edit-bound rejections, locked-field mutation attempts, RFC 6902 diff output, and IPv4/IPv6 SSRF CIDR blocking.
*   **Rationale**: Validates core domain invariants in isolation before API integration.

#### 4. `packages/db/src/schema.ts`, `packages/db/src/index.ts`, `packages/db/src/migrate.ts`, `packages/db/drizzle.config.ts` (Create)
*   **Type / Scope**: PostgreSQL Schema & Drizzle Client (`@hitl/db`)
*   **Proposed Changes**: Define Drizzle tables for Better Auth (`usePlural: true` + `organization` plugin: `users`, `sessions`, `accounts`, `verifications`, `organizations`, `members`, `invitations`), `projects`, `api_keys`, `policies`, `approval_requests` (including `initial_policy_snapshot`, `effective_policy_snapshot`, `required_approvals`, `payload_version`, `edit_count`), `approval_tokens` (no `action_nonce_hash`), `approval_votes` (partial unique index on `(approval_request_id, approver_email, payload_version) WHERE superseded_at IS NULL`), `audit_logs` (`ON DELETE RESTRICT`), and `webhook_deliveries`.
*   **Rationale**: Encodes all data integrity invariants and shared Drizzle types.

#### 5. `packages/db/drizzle/0000_init.sql`, `packages/db/drizzle/0001_audit_immutability_trigger.sql`, `packages/db/drizzle/meta/_journal.json` (Create)
*   **Type / Scope**: SQL Migrations
*   **Proposed Changes**: Generate initial schema via `drizzle-kit generate` and add the `BEFORE UPDATE OR DELETE` immutability trigger on `audit_logs` via `drizzle-kit generate --custom --name=audit_immutability_trigger` so `_journal.json` tracks both migrations.
*   **Rationale**: Guarantees `drizzle-kit migrate` applies both schema and trigger deterministically.

#### 6. `apps/api/nest-cli.json`, `apps/api/src/main.ts`, `app.module.ts`, `auth/auth.ts`, `auth/auth.guard.ts`, `common/api-key.guard.ts`, `common/zod-validation.pipe.ts`, `common/crypto.service.ts`, `db/db.module.ts`, `workers/queues.module.ts` (Create)
*   **Type / Scope**: NestJS 12 Bootstrap, Auth, Security, DB, & BullMQ Infrastructure (`@hitl/api`)
*   **Proposed Changes**:
    *   `main.ts`: Initialize `NestFactory.create(AppModule, { bodyParser: false })`, mount Better Auth handler on `/api/auth/*`, and apply JSON + raw-body parser middleware only to non-auth routes (`/v1/*`).
    *   `auth/auth.ts` & `auth/auth.guard.ts`: Configure Better Auth (`drizzleAdapter` with `usePlural: true`, `organization` plugin, `trustedOrigins: [WEB_URL]`, `advanced: { trustedProxyHeaders: true }`) and NestJS session guard for `/v1/dashboard/*`.
    *   `common/api-key.guard.ts` & `zod-validation.pipe.ts`: Bearer `hk_live_...` SHA-256 auth guard and Zod request pipe.
    *   `common/crypto.service.ts`: SHA-256 hashing (API keys, magic tokens, idempotency request payloads), versioned AES-256-GCM (`v1:...`), stateless `action_nonce` HMAC signing/verification, and `HMAC-SHA256` webhook signing.
    *   `db/db.module.ts` & `workers/queues.module.ts`: Drizzle provider and `@nestjs/bullmq` queues (`timeouts`, `webhooks`, `emails`, `reconciliation`).
*   **Rationale**: Establishes the auth, raw-body, crypto, DB, and queue primitives required by all API modules.

#### 7. `apps/api/src/approvals/approvals.controller.ts`, `approvals.service.ts` (Create)
*   **Type / Scope**: Core Approval Ingestion & Polling API
*   **Proposed Changes**:
    *   `POST /v1/approvals` (API key auth): SSRF literal-IP check, idempotency hash check (`409 Conflict` on mismatch), fail-closed policy evaluation, synchronous `200 OK` return for `auto_approved`/`auto_rejected` (no webhook), or `202 Accepted` + `approval_tokens` + `timeout:${id}` BullMQ job + Resend email enqueue for `pending`.
    *   `GET /v1/approvals/:id` & `GET /v1/approvals`: Scoped to API key project (or Better Auth session for `/v1/dashboard/approvals`).
*   **Rationale**: Implements the primary agent ingestion entrypoint.

#### 8. `apps/api/src/review/review.controller.ts`, `review.service.ts` (Create)
*   **Type / Scope**: Anti-Prefetch Magic-Link Decision API
*   **Proposed Changes**:
    *   `GET /v1/review/:token`: Strictly read-only (no DB writes); validates `token_hash` and returns context, `payload_version`, `editable_schema`, branding, and stateless HMAC `action_nonce`.
    *   `POST /v1/review/:token/viewed`: Client-side beacon recording `viewed` in `audit_logs`.
    *   `POST /v1/review/:token/decide`: Rate-limited per IP/token; verifies `action_nonce` signature + Redis `SET NX` single-use `jti`; locks `approval_requests` (`SELECT ... FOR UPDATE`), validates `payload_version` and `editable_schema`, caps `edit_count <= 3`, re-evaluates policy (monotonic `required_approvals` or `auto_reject`), supersedes prior votes on edit, inserts `approval_votes`, and on terminal state writes `audit_logs` + `pending` `webhook_deliveries` row in the same transaction before cancelling `timeout:${id}` and enqueuing webhook delivery.
*   **Rationale**: Enforces anti-prefetch safety, edit validation, and atomic multi-approver consensus.

#### 9. `apps/api/src/workers/timeout.processor.ts`, `webhook.processor.ts`, `email.processor.ts`, `reconciliation.processor.ts` (Create)
*   **Type / Scope**: BullMQ Background Workers
*   **Proposed Changes**:
    *   `timeout.processor.ts`: Locks `approval_requests`, transitions `pending` -> `timed_out`, writes `audit_logs` + `pending` `webhook_deliveries` in one transaction, and enqueues webhook delivery.
    *   `webhook.processor.ts`: Resolves DNS, validates IP via `@hitl/shared` SSRF check, pins IP in custom HTTP `lookup` hook, disables redirects (`redirect: 'manual'`), enforces 10s timeout + 4 KB `response_body` truncation, stops early on `400`/`404`/`410`, and retries `429`/`5xx`/timeouts (max 5 attempts, exponential backoff).
    *   `email.processor.ts`: Dispatches branded magic-link review (`${WEB_URL}/p/${orgSlug}/review/${token}`) and re-notification emails via **Resend**.
    *   `reconciliation.processor.ts`: Repeatable 15s BullMQ job sweeping expired `pending` `approval_requests` and orphaned `pending` `webhook_deliveries` (> 10s old).
*   **Rationale**: Guarantees fail-closed timeout enforcement and crash-safe webhook delivery.

#### 10. `apps/api/src/dashboard/projects.controller.ts`, `policies.controller.ts`, `approvals.controller.ts`, `audit.controller.ts` (Create)
*   **Type / Scope**: Agency Admin APIs (Better Auth Session Guard)
*   **Proposed Changes**: Session-protected CRUD for projects, dual-key `webhook_secret` rotation, API keys, policy rules, approval queue listing (`/v1/dashboard/approvals`), `webhook_deliveries` inspection, and `audit_logs` viewing/export (CSV/JSON).
*   **Rationale**: Powers the agency admin dashboard without mixing unauthenticated external webhooks.

#### 11. `apps/api/test/jest-e2e.json`, `apps/api/test/approvals.e2e-spec.ts` (Create)
*   **Type / Scope**: API & Worker Integration Tests
*   **Proposed Changes**: Configure Jest (`NODE_OPTIONS=--experimental-vm-modules` or CJS with Node `>= 20.19.0` `require(esm)` for NestJS 12) and test end-to-end against Docker PostgreSQL + Redis: synchronous `auto_approved`/`auto_rejected`, idempotency `409`, read-only `GET` prefetch safety + double-submit nonce rejection, edit-before-execute policy escalation, multi-approver vote reset + `edit_count` cap, atomic timeout vs. vote race, transactional outbox reconciliation, `audit_logs` trigger rejection on `UPDATE`/`DELETE`, SSRF redirect blocking, and early stop on `410`.
*   **Rationale**: Verifies every CUJ and database/worker reliability invariant against real services.

#### 12. `apps/web/next.config.ts`, `postcss.config.mjs`, `components.json`, `src/app/globals.css`, `src/app/layout.tsx`, `src/lib/auth-client.ts`, `src/lib/api-client.ts`, `src/app/login/page.tsx`, `src/app/p/[orgSlug]/review/[token]/page.tsx`, `src/components/review/editable-form.tsx` (Create)
*   **Type / Scope**: Next.js 16 Portal & Shared Client Setup (`@hitl/web`)
*   **Proposed Changes**: Configure Next.js rewrites (`/api/auth/:path*` -> `${API_INTERNAL_URL}/api/auth/:path*`, `/api/v1/:path*` -> `${API_INTERNAL_URL}/v1/:path*`, defaulting `API_INTERNAL_URL` to `http://localhost:3001`), Tailwind v4 `postcss.config.mjs` + `globals.css`, and `transpilePackages: ['@hitl/shared']`; set up Better Auth client, login page, and the magic-link review page (read-only `GET` fetch, `viewed` beacon on mount, `editable_schema` typed form + live diff preview, `POST /api/v1/review/:token/decide` submission).
*   **Rationale**: Eliminates cross-origin cookie issues and implements the end-client review portal.

#### 13. `apps/web/src/app/(dashboard)/layout.tsx`, `projects/page.tsx`, `policies/page.tsx`, `queue/page.tsx`, `webhooks/page.tsx`, `audit/page.tsx` (Create)
*   **Type / Scope**: Agency Admin Dashboard (`@hitl/web`)
*   **Proposed Changes**: Better Auth session gate + org switcher, project/API key/secret rotation management, policy rule builder, live approval queue, webhook delivery & retry inspector, and audit log viewer with CSV/JSON export.
*   **Rationale**: Gives agencies full self-serve control over client projects, policies, and audit trails.

#### 14. `templates/n8n/hitl-approval-workflow.json`, `docs/n8n-quickstart.md` (Create)
*   **Type / Scope**: Zero-Install n8n Workflow Template & Quickstart
*   **Proposed Changes**: Importable n8n workflow JSON (`HTTP Request` -> `IF status === 'pending'` -> `Wait (On Webhook Call)` -> `Code` node verifying `X-Signature-256` with `timingSafeEqual` and `<= 300s` `X-HITL-Timestamp` skew) plus setup documentation for n8n Cloud and self-hosted.
*   **Rationale**: Enables immediate agency adoption without waiting for n8n community node verification.

### Verification Plan

*   **Compilation & Typecheck**: `pnpm turbo build && pnpm turbo typecheck` across all `@hitl/*` workspaces.
*   **Static Analysis & Linting**: `pnpm turbo lint` (ESLint + Prettier).
*   **Unit Tests**: `pnpm --filter @hitl/shared test` (Vitest) passing all `policy-evaluator`, `editable-schema`, and `ssrf` suites.
*   **E2E/Integration Tests**: Start test services via `docker compose up -d`, run `pnpm --filter @hitl/db db:migrate`, and run `pnpm --filter @hitl/api test:e2e` verifying all 3 CUJs, database trigger immutability, reconciliation recovery, and webhook retry/stop behavior.
*   **Web & n8n Template Verification**: Verify `apps/web` production build (`pnpm --filter @hitl/web build`) and validate `templates/n8n/hitl-approval-workflow.json` parses cleanly and contains the `IF status === 'pending'` gate and HMAC verification code node.

--------------------------------------------------------------------------------

*Drafted with EGM*
