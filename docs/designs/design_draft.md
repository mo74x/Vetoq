# Reliability-First HITL Approval Layer (v1: n8n + Magic-Link Portal)

*   **Author:** Mohamed Arafa (Mo74x)
*   **Status:** Draft
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

*   **Zero-Install n8n Integration:** Work on both n8n Cloud and self-hosted n8n on Day 1 using copy-pasteable native `HTTP Request` + `Wait` + HMAC verification templates (no unverified community npm node required).
*   **Anti-Prefetch Magic-Link Portal:** Provide a read-only `GET` review page with hosted agency branding (`logo_url`, `accent_color`, path-based `/p/:orgSlug/review/:token`) and `POST`-only decision submission protected by a single-use `action_nonce` (and optional email OTP).
*   **Validated Edit-Before-Execute:** Render typed forms from `editable_schema`, enforce field mutability and bounds (`min`/`max`) on the server, compute RFC 6902 JSON diffs, and re-run policy evaluation on `final_payload` before resuming.
*   **Multi-Approver Consensus:** Track per-approver votes in `approval_votes` and reset prior approvals if any reviewer edits the payload so all required approvers sign off on the exact same `final_payload`.
*   **Fail-Closed Execution & Append-Only Audit:** Default unmatched policies, parse errors, and timeouts to rejection/escalation (never silent approval), and enforce immutability on `audit_logs` at the PostgreSQL level.

## Non-Goals

*   **Slack OAuth & Block Kit Edit Modals (Deferred to Phase 2):** v1 routes reviews through the magic-link web portal and email notifications.
*   **TypeScript/Python SDKs & `@agentgate/mcp` Middleware (Deferred to Phase 2):** Blocking `requestAndWait` polling and MCP tool wrappers are out of scope for v1.
*   **Verified `n8n-nodes-agentgate` Community Node (Deferred to Phase 1.5/2):** v1 uses native n8n HTTP + Wait workflow JSON templates.
*   **Custom Agency Domains & Custom SMTP (Deferred to Phase 2):** v1 uses hosted path branding (`/p/:orgSlug/...`) and `Reply-To` headers rather than per-agency TLS/DNS provisioning.
*   **Fail-Open Timeouts (`timeout_behavior = 'approve'`):** Excluded from v1 to preserve fail-closed safety.

## Open Questions

*   **Optional Email OTP Threshold:** Whether 6-digit email OTP verification on magic-link `POST` should be configurable per policy or globally toggled per project in v1.

## Critical User Journeys (CUJs)

### CUJ 1: Single-Approver Edit-Before-Execute via n8n

*   **Given**: An agency has configured a project, a policy requiring 1 approval for `stripe.refund` over `$50`, and an n8n workflow using the v1 HTTP + Wait template.
*   **When**: The n8n workflow calls `POST /v1/approvals` with a `$240` refund payload and `editable_schema`. The end-client opens the emailed magic link (`GET /p/:orgSlug/review/:token`), changes `refund_amount_usd` to `120`, and clicks **Approve with Edits**.
*   **Then**: The server validates the edit against `editable_schema`, re-runs policy evaluation, records `edited_and_approved` and the JSON diff in `audit_logs`, cancels the BullMQ timeout job, and dispatches an HMAC-signed webhook to the n8n Wait resume URL containing `final_payload`.

### CUJ 2: Multi-Approver Consensus with Edit Reset

*   **Given**: A policy requires `required_approvals = 2` for `stripe.refund` over `$500`, with two approver emails configured.
*   **When**: Approver A submits an `approve` vote, and then Approver B edits `refund_amount_usd` from `$600` to `$550` and submits an `approve` vote.
*   **Then**: Approver A's prior `approve` vote is invalidated/superseded because the payload changed, the request remains `pending` with 1 valid vote (Approver B's) on the new payload, and Approver A is notified to re-confirm the updated `final_payload` before the webhook fires.

### CUJ 3: Fail-Closed Timeout & Permanent Webhook Failure Handling

*   **Given**: An approval request is `pending` with `timeout_seconds = 1800`.
*   **When**: No human decides before `expires_at`, so the BullMQ timeout worker fires.
*   **Then**: The worker atomically transitions the request from `pending` to `timed_out` (using row locking so a simultaneous human click cannot race), writes a `timed_out` audit event, and fires the signed webhook with `status: "timed_out"`. If the n8n Wait URL returns `404`/`410`, the worker marks `delivery_status = "delivery_failed"` without futile retries.

## Technical Plan (Architecture)

### 1. Monorepo & Deployment Topology

The system is a pure TypeScript monorepo managed with **Turborepo + pnpm**:

*   `apps/web` (**Next.js 16 + Tailwind CSS + shadcn/ui**, hosted on Vercel): Serves the agency admin dashboard (Better Auth sessions), audit log viewer, policy builder, webhook retry inspector, and read-only branded magic-link review pages (`/p/:orgSlug/review/:token`).
*   `apps/api` (**NestJS 12 + Zod + BullMQ**, hosted on Railway or Hetzner/Coolify): Serves `/v1/approvals`, `/v1/review/:token/*`, and internal dashboard APIs; runs BullMQ workers for SLA timeout jobs and webhook delivery retries; dispatches emails via Resend/Postmark.
*   `packages/shared`: Shared Zod request/response schemas, `editable_schema` validator, RFC 6902 JSON diffing utility, and policy evaluation logic.
*   `packages/db`: Drizzle ORM schema, SQL migrations (including `audit_logs` immutability trigger), and PostgreSQL client.
*   `packages/sdk` *(reserved for Phase 2)*: TypeScript SDK and `@agentgate/mcp` middleware.

```text
+-------------------+        POST /v1/approvals         +-----------------------------+
|  n8n Workflow     | --------------------------------> | apps/api (NestJS 12 + Zod)  |
|  (HTTP + Wait)    | <-------------------------------- |  - Policy Engine            |
+-------------------+   Signed Webhook (X-Signature-256)|  - BullMQ Timeout/Retry     |
                                                        +--------------+--------------+
                                                                       |
                                                        PostgreSQL + Drizzle ORM + Redis
                                                                       |
+-------------------+   GET /p/:orgSlug/review/:token   +--------------+--------------+
|  End-Client       | --------------------------------> | apps/web (Next.js 16)       |
|  Browser          |   POST /v1/review/:token/decide   |  - Read-only Review UI      |
|                   | --------------------------------> |  - Agency Admin Dashboard   |
+-------------------+        (to apps/api)              +-----------------------------+
```

### 2. PostgreSQL Data Model (Drizzle ORM)

All tables live in PostgreSQL (`packages/db`) and resolve the gaps from the original blueprint:

*   **Auth & Tenancy:** Better Auth core tables (`users`, `sessions`, `accounts`, `verifications`) plus `organizations` (`id`, `name`, `slug`, `plan`, `branding_config JSONB`) and `org_memberships` (`org_id`, `user_id`, `role`).
*   **`projects`:** `id`, `org_id`, `name`, `webhook_secret_enc`, `webhook_secret_prev_enc` (nullable for zero-downtime secret rotation), `otp_required` (`BOOLEAN DEFAULT FALSE`), `deleted_at` (soft delete).
*   **`api_keys`:** `id`, `project_id`, `name`, `key_prefix`, `key_hash UNIQUE`, `last_used_at`, `revoked_at`.
*   **`policies`:** `id`, `project_id`, `action_type`, `priority`, `conditions JSONB`, `decision_mode` (`auto_approve | require_approval | auto_reject`), `required_approvals`, `timeout_seconds`, `timeout_behavior` (`reject | escalate` — fail-open `approve` removed), `approver_emails TEXT[]`, `is_active`.
*   **`approval_requests`:**
    *   `id`, `project_id`, `policy_id` (`ON DELETE SET NULL`), `policy_snapshot JSONB` (captured at creation for auditability).
    *   `idempotency_key`, `idempotency_request_hash` (`UNIQUE(project_id, idempotency_key)`).
    *   `action_type`, `title`, `summary`, `agent_name`, `original_payload JSONB`, `final_payload JSONB`, `editable_schema JSONB`.
    *   Separated state fields: `status` (`pending | auto_approved | approved | edited_and_approved | rejected | timed_out | cancelled`) and `delivery_status` (`not_applicable | pending | delivered | delivery_failed`).
    *   `callback_url`, `expires_at`, `decided_at`, `deleted_at`.
*   **`approval_tokens`:** `id`, `approval_request_id`, `approver_email`, `token_hash UNIQUE`, `action_nonce_hash`, `expires_at`, `revoked_at`, `used_at`. Enables per-approver attribution and token revocation.
*   **`approval_votes`:** `id`, `approval_request_id`, `approver_email`, `approver_name`, `decision` (`approve | reject`), `edited_payload JSONB`, `note`, `superseded_at` (nullable; set when a subsequent reviewer edits the payload), `created_at`. Enforces one active vote per `(approval_request_id, approver_email)` via partial unique index `WHERE superseded_at IS NULL`.
*   **`audit_logs`:** `id`, `project_id` (`ON DELETE RESTRICT`), `approval_request_id` (`ON DELETE RESTRICT`), `event_type`, `actor_type`, `actor_identifier`, `diff_payload JSONB`, `metadata JSONB`, `created_at`. Protected by a PostgreSQL `BEFORE UPDATE OR DELETE` trigger that raises an exception.
*   **`webhook_deliveries`:** `id`, `approval_request_id`, `callback_url`, `attempt_number`, `http_status`, `response_body`, `status` (`pending | succeeded | failed`), `next_retry_at`, `created_at`.

### 3. Core Flows & Reliability Invariants

1.  **Request Ingestion (`POST /v1/approvals`):**
    *   Authenticate Bearer API key (`key_hash`), validate payload with Zod, and verify `callback_url` is not a private, loopback, or link-local IP (SSRF check).
    *   Check `(project_id, idempotency_key)`: if present and `idempotency_request_hash` matches, return cached response; if hash differs, return `409 Conflict`.
    *   Evaluate active policies ordered by `priority ASC` (first match wins). If no policy matches or a condition fails to parse, fail closed to `require_approval` (`required_approvals = 1`, `timeout_behavior = 'reject'`).
    *   If `require_approval`, create `approval_requests`, per-approver rows in `approval_tokens`, schedule a BullMQ delayed timeout job (`expires_at`), and dispatch magic-link emails.
2.  **Anti-Prefetch Magic-Link Decision (`GET` in `apps/web`, `POST` in `apps/api`):**
    *   `GET /p/:orgSlug/review/:token` fetches read-only request metadata and a single-use `action_nonce` from `apps/api`. It never mutates `status` or consumes the token; `viewed` audit events are sent via an explicit client-side beacon after page hydration.
    *   `POST /v1/review/:token/decide` verifies `token_hash`, `action_nonce`, and (if enabled) a 6-digit email OTP.
    *   Inside a PostgreSQL transaction with `SELECT ... FOR UPDATE` on `approval_requests`:
        *   Reject with `409 Conflict` if `status !== 'pending'`.
        *   If edits are submitted, validate against `editable_schema` (rejecting edits to `editable: false` fields or out-of-bounds values), compute RFC 6902 `diff_payload`, and re-run policy evaluation on `final_payload`. If the edited payload triggers a stricter policy (e.g., higher `required_approvals`), update `policy_snapshot` and `required_approvals`.
        *   If `final_payload` changed relative to the current proposed payload, mark prior `approval_votes` as `superseded_at = NOW()` so all required approvers sign off on the identical `final_payload`, and re-notify prior approvers.
        *   Record the vote in `approval_votes`. If active `approve` votes reach `required_approvals` (or if `decision === 'reject'`), transition `status`, cancel the BullMQ timeout job, write `audit_logs`, and enqueue the webhook delivery job.
3.  **Webhook Delivery & Timeout Workers (BullMQ):**
    *   Timeout job acquires `SELECT ... FOR UPDATE` on `approval_requests`; if still `pending`, transitions to `timed_out` (or escalates), writes `audit_logs`, and enqueues webhook delivery.
    *   Webhook worker re-validates resolved DNS IP against private/link-local ranges (DNS-rebinding protection), signs `"${timestamp}.${rawBody}"` with `HMAC-SHA256`, and sends `X-HITL-Timestamp` + `X-Signature-256`.
    *   On `400`, `404`, or `410` (expired n8n Wait URL), stop retrying immediately and mark `delivery_status = 'delivery_failed'`. Retry with exponential backoff only on `429`, `5xx`, or network timeouts.
4.  **Zero-Install n8n Template Pack:**
    *   Ship a copy-pasteable n8n workflow JSON using native `HTTP Request` (`POST /v1/approvals`, passing `$execution.resumeUrl` as `callback_url`), `Wait (On Webhook Call)`, and a `Code` node that verifies `X-Signature-256` against `webhook_secret` (and `webhook_secret_prev` during rotation) before executing downstream actions using `final_payload`.

## Alternatives Considered

### Alternative A: Build for Agencies and Software Engineers Simultaneously (Original Blueprint)

*   **Pros**: Addresses both white-label client approvals and developer SDK/MCP use cases from day one.
*   **Cons**: Splits a solo builder across a branded web portal, Slack OAuth/Block Kit modals, TypeScript/Python SDKs (`requestAndWait`), MCP middleware, and an n8n node in 6 weeks.
*   **Reason for Rejection**: Rejected by author: splitting surface area across two distinct buyer loops delays shipping a reliable core state machine and prevents fast validation with the primary agency wedge.

### Alternative B: Lead with `n8n-nodes-agentgate` Community Node on Day 1

*   **Pros**: Slightly cleaner n8n canvas UX with a single custom node.
*   **Cons**: n8n Cloud blocks unverified community npm nodes, excluding n8n Cloud agencies from Day-1 onboarding and adding npm publishing/maintenance overhead before validation.
*   **Reason for Rejection**: Rejected by author: copy-pasteable native `HTTP Request` + `Wait` + `Code` workflow JSON templates work immediately on both n8n Cloud and self-hosted instances.

### Alternative C: Lock the Magic-Link Client Portal Behind the $249/mo Agency Tier

*   **Pros**: Reserves the primary agency hook for the highest self-serve pricing tier.
*   **Cons**: Agencies cannot test the end-client magic-link experience in Free or Pro before committing to $249/mo.
*   **Reason for Rejection**: Rejected by author: agencies need to experience the magic-link portal during onboarding; pricing should gate active client projects, custom branding, and monthly approval volume instead.

### Alternative D: Separate Backend and Frontend Repositories

*   **Pros**: Independent CI pipelines and zero coupling between NestJS and Next.js builds.
*   **Cons**: Requires duplicating or publishing Zod schemas, `editable_schema` validators, and Drizzle types across repos, slowing down TypeScript refactoring.
*   **Reason for Rejection**: Rejected by author: a single Turborepo + pnpm monorepo keeps `apps/web`, `apps/api`, `packages/shared`, and `packages/db` strictly typed end-to-end.

### Alternative E: Single `magic_token_hash` Column and Fail-Open Timeouts

*   **Pros**: Simpler initial schema with two fewer tables (`approval_tokens`, `approval_votes`).
*   **Cons**: Cannot attribute votes in multi-approver policies, cannot revoke individual approver links, leaves `GET` links vulnerable to email scanner pre-fetches, and `timeout_behavior = 'approve'` risks executing unreviewed high-stakes actions.
*   **Reason for Rejection**: Rejected by author: reliability-first approvals require per-approver capability tokens, vote consensus tracking, and fail-closed timeouts.

## Non-Functional Requirements

*   **Security & Privacy**:
    *   API keys (`hk_live_...`) and magic tokens are stored only as SHA-256 hashes; project `webhook_secret` values are encrypted at rest with envelope encryption (`APP_ENCRYPTION_KEY`) and support zero-downtime rotation via `webhook_secret_prev_enc`.
    *   SSRF protection blocks private, loopback, and link-local IP ranges both on `callback_url` submission and immediately before DNS resolution in the BullMQ webhook worker.
    *   `audit_logs` is protected by `ON DELETE RESTRICT` and a PostgreSQL `BEFORE UPDATE OR DELETE` trigger.
*   **Performance & Latency**:
    *   `POST /v1/approvals` targets sub-150ms p95 response time (policy evaluation + DB insert + BullMQ enqueue; email dispatch runs asynchronously via BullMQ so SMTP/API latency never blocks the caller).
*   **Rollout & Rollback**:
    *   Database schema changes are managed via forward-only Drizzle SQL migrations.
    *   Because no legacy production data exists yet, v1 launches directly behind API key project isolation; Phase 2 features (Slack, SDKs, MCP) will be gated per-project.

## Detailed Implementation Plan

All new files live inside a single Turborepo + pnpm monorepo at the repository root. Per-project email OTP verification (`projects.otp_required`) is implemented as a project-level boolean toggle in v1.

### Target Files to Create/Modify

#### 1. `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json` (Create)
*   **Type / Scope**: Monorepo Configuration
*   **Proposed Changes**: Define pnpm workspaces (`apps/*`, `packages/*`), Turborepo pipelines (`build`, `lint`, `test`, `typecheck`, `db:migrate`), and shared strict TypeScript compiler options. Necessary to coordinate pure TypeScript builds and shared typechecking across `apps/web`, `apps/api`, `packages/shared`, and `packages/db`.

#### 2. `packages/shared/src/schemas.ts`, `packages/shared/src/policy-evaluator.ts`, `packages/shared/src/editable-schema.ts`, `packages/shared/src/ssrf.ts` (Create)
*   **Type / Scope**: Shared Domain & Validation Library
*   **Proposed Changes**:
    *   `schemas.ts`: Zod schemas for `CreateApprovalRequest`, `SubmitDecisionRequest`, `PolicyRule`, and `WebhookCallbackPayload`.
    *   `policy-evaluator.ts`: Deterministic `priority ASC` first-match evaluator returning `auto_approve | require_approval | auto_reject` and failing closed (`require_approval`) on no-match or condition parse errors.
    *   `editable-schema.ts`: Server-side validator enforcing `editable: true`, types, and `min`/`max`/`maxLength` bounds, plus RFC 6902 JSON diff generation between `original_payload` and `final_payload`.
    *   `ssrf.ts`: URL and resolved-IP validator rejecting private, loopback, and link-local CIDR ranges (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fc00::/7`).
*   **Rationale**: Centralizing validation and policy logic prevents schema drift between `apps/api` and `apps/web`.

#### 3. `packages/shared/src/__tests__/policy-evaluator.spec.ts`, `packages/shared/src/__tests__/editable-schema.spec.ts`, `packages/shared/src/__tests__/ssrf.spec.ts` (Create)
*   **Type / Scope**: Unit Tests
*   **Proposed Changes**: Cover fail-closed policy misses, edit-bound rejections, locked-field mutation attempts, RFC 6902 diff output, and SSRF IP blocking.

#### 4. `packages/db/src/schema.ts`, `packages/db/src/index.ts`, `packages/db/drizzle.config.ts` (Create)
*   **Type / Scope**: PostgreSQL Schema & Drizzle Client
*   **Proposed Changes**: Define Drizzle tables for Better Auth (`users`, `sessions`, `accounts`, `verifications`), `organizations`, `org_memberships`, `projects` (with `webhook_secret_enc`, `webhook_secret_prev_enc`, `otp_required`, `deleted_at`), `api_keys`, `policies`, `approval_requests`, `approval_tokens`, `approval_votes` (with partial unique index on active votes), `audit_logs` (`ON DELETE RESTRICT`), and `webhook_deliveries`.

#### 5. `packages/db/drizzle/0001_init.sql`, `packages/db/drizzle/0002_audit_immutability_trigger.sql` (Create)
*   **Type / Scope**: SQL Migrations
*   **Proposed Changes**: Generate initial schema migration and add a PostgreSQL `BEFORE UPDATE OR DELETE` trigger on `audit_logs` that raises an exception to enforce append-only immutability at the database layer.

#### 6. `apps/api/src/app.module.ts`, `apps/api/src/main.ts`, `apps/api/src/common/crypto.service.ts` (Create)
*   **Type / Scope**: NestJS Application Bootstrap & Security Utilities
*   **Proposed Changes**: Configure NestJS 12 with raw-body preservation, Zod validation pipe, SHA-256 hashing for API keys/magic tokens/idempotency hashes, AES-256-GCM envelope encryption for `webhook_secret_enc`, and `HMAC-SHA256` webhook signing (`X-HITL-Timestamp` + `X-Signature-256`).

#### 7. `apps/api/src/approvals/approvals.controller.ts`, `apps/api/src/approvals/approvals.service.ts` (Create)
*   **Type / Scope**: Core Approval Ingestion & Management API
*   **Proposed Changes**: Implement `POST /v1/approvals` (API key guard, SSRF URL check, idempotency hash check returning `409 Conflict` on mismatch, fail-closed policy evaluation, `approval_tokens` creation, BullMQ timeout job enqueue, email notification enqueue) and `GET /v1/approvals/:id` / `GET /v1/approvals` for dashboard and polling.

#### 8. `apps/api/src/review/review.controller.ts`, `apps/api/src/review/review.service.ts` (Create)
*   **Type / Scope**: Anti-Prefetch Magic-Link Decision API
*   **Proposed Changes**:
    *   `GET /v1/review/:token`: Read-only endpoint returning request context, `editable_schema`, branding config, and a short-lived `action_nonce` (never mutates approval state).
    *   `POST /v1/review/:token/viewed`: Explicit client-side beacon endpoint to record `viewed` in `audit_logs`.
    *   `POST /v1/review/:token/otp` & `POST /v1/review/:token/decide`: Optional 6-digit email OTP verification, `SELECT ... FOR UPDATE` row lock, `editable_schema` validation, policy re-evaluation on `final_payload`, vote superseding (`superseded_at = NOW()`) on payload edits, consensus check, BullMQ timeout job cancellation, `audit_logs` write, and webhook job enqueue.

#### 9. `apps/api/src/workers/timeout.processor.ts`, `apps/api/src/workers/webhook.processor.ts`, `apps/api/src/workers/email.processor.ts` (Create)
*   **Type / Scope**: BullMQ Background Workers
*   **Proposed Changes**:
    *   `timeout.processor.ts`: Atomically transitions `pending` requests to `timed_out` (with `SELECT ... FOR UPDATE`), writes `audit_logs`, and enqueues webhook delivery.
    *   `webhook.processor.ts`: Performs pre-request DNS resolution + SSRF IP check, dispatches signed `POST` to `callback_url`, records attempts in `webhook_deliveries`, stops retrying immediately on `400`/`404`/`410`, and retries `429`/`5xx`/timeouts with exponential backoff.
    *   `email.processor.ts`: Sends branded magic-link review emails and OTP codes via Resend/Postmark.

#### 10. `apps/api/src/dashboard/projects.controller.ts`, `apps/api/src/dashboard/policies.controller.ts`, `apps/api/src/dashboard/audit.controller.ts` (Create)
*   **Type / Scope**: Agency Admin & Billing APIs
*   **Proposed Changes**: Better Auth session-protected endpoints for managing projects, rotating `webhook_secret` (preserving `webhook_secret_prev_enc`), managing API keys, CRUD on policy rules, viewing/exporting `audit_logs` (CSV/JSON), inspecting `webhook_deliveries`, and handling Paddle/Polar billing webhooks.

#### 11. `apps/api/test/approvals.e2e-spec.ts` (Create)
*   **Type / Scope**: API & Worker Integration Tests
*   **Proposed Changes**: Test full lifecycle against PostgreSQL + Redis: idempotency mismatch (`409`), read-only `GET` prefetch safety, edit-before-execute policy escalation, multi-approver vote reset on edit, atomic timeout vs. vote race, `audit_logs` update/delete rejection, and permanent `410` webhook stop.

#### 12. `apps/web/src/app/p/[orgSlug]/review/[token]/page.tsx`, `apps/web/src/components/review/editable-form.tsx` (Create)
*   **Type / Scope**: Branded Magic-Link Review Portal (Next.js 16 + Tailwind + shadcn/ui)
*   **Proposed Changes**: Render agency-branded read-only review page, fire `POST /v1/review/:token/viewed` beacon on mount, render typed inputs from `editable_schema` with live diff preview, handle optional OTP prompt, and submit `POST /v1/review/:token/decide` with `action_nonce`.

#### 13. `apps/web/src/app/(dashboard)/layout.tsx`, `apps/web/src/app/(dashboard)/projects/page.tsx`, `apps/web/src/app/(dashboard)/policies/page.tsx`, `apps/web/src/app/(dashboard)/audit/page.tsx` (Create)
*   **Type / Scope**: Agency Admin Dashboard (Next.js 16 + Better Auth)
*   **Proposed Changes**: Better Auth login/org switcher, project & API key management, policy rule builder, approval queue & webhook retry inspector, and audit log viewer with CSV/JSON export.

#### 14. `templates/n8n/hitl-approval-workflow.json`, `docs/n8n-quickstart.md` (Create)
*   **Type / Scope**: Zero-Install n8n Distribution Wedge
*   **Proposed Changes**: Copy-pasteable n8n workflow JSON (`HTTP Request` -> `Wait (On Webhook Call)` -> `Code` node HMAC-SHA256 verification) and quickstart guide compatible with both n8n Cloud and self-hosted instances.

### Verification Plan

*   **Compilation/Build**: `pnpm turbo build` and `pnpm turbo typecheck` across all workspaces.
*   **Unit Tests**: `pnpm --filter @hitl/shared test` covering `policy-evaluator`, `editable-schema`, and `ssrf`.
*   **Static Analysis & Linting**: `pnpm turbo lint` (ESLint + Prettier checks).
*   **E2E/Integration**: `pnpm --filter @hitl/api test:e2e` against test PostgreSQL + Redis containers verifying all 3 CUJs, database trigger immutability, and webhook retry/stop behavior.

--------------------------------------------------------------------------------

*Drafted with EGM*
