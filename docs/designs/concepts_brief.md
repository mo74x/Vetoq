# Reliability-First HITL Approval Layer (Day-1 n8n + Magic-Link Wedge)

* **Author:** Mohamed Arafa (Mo74x)
* **Date:** 2026-11-21

## Overview

This concept turns [ai_agent_approval_queue_blueprint.md](file:///c:/Users/3rafa/Desktop/projects/hitl_agent/ai_agent_approval_queue_blueprint.md) into a focused v1 product: a human-in-the-loop (HITL) approval API and web review portal.

* **Target User (Day-1 Wedge):** AI automation agencies building client workflows (starting with n8n) who need non-technical end-clients to review, edit, and approve agent actions without logging into a developer tool or Slack workspace.
* **Core Value Proposition:** Instead of building fragile custom approval webhooks per client, an agency plugs in one HTTP + Wait template. High-risk actions pause, route through deterministic policy rules, and generate a secure magic-link review page where a human can edit specific fields before resuming execution—with an append-only audit log and HMAC-signed webhook delivery.
* **Phase 2 Expansion:** Once the core state machine and agency wedge are validated in production, add Slack Block Kit modals, TypeScript/Python SDKs, and MCP tool middleware.

## Analysis

A multi-lens review of the original blueprint found **7 critical gaps and contradictions** that must be fixed before writing production code, plus concrete ways to resolve them:

### 1. Core Blueprint Gaps & Contradictions
1. **Multi-approver voting has no schema support:** `policies.required_approvals` promises multi-approver quorum, but `approval_requests` only stores a single `decided_by_name`, `decided_by_email`, and `decided_at`.
2. **Single `magic_token_hash` breaks attribution and link-scanner safety:** One token per request cannot identify which approver voted, and email security scanners (Defender Safe Links, Proofpoint, Mimecast) pre-fetch `GET` URLs.
3. **Decision state and webhook delivery state are mixed:** The state diagram ends in `[DELIVERED]` / `[DELIVERY_FAILED]`, while `approval_requests.status` only tracks decision states (`pending`, `approved`, `rejected`, `timed_out`).
4. **Fail-open `timeout_behavior = 'approve'` is unsafe:** Automatically approving unsupervised actions when a human fails to respond contradicts the core reliability promise.
5. **Unvalidated `Edit-Before-Execute` can bypass policies:** A human editing `refund_amount_usd` from `$200` to `$20,000` (or editing a locked field) is not re-checked against `editable_schema` or policy thresholds on the server.
6. **n8n Cloud blocks unverified community nodes:** Relying on `n8n-nodes-agentgate` on Day 1 locks out n8n Cloud users.
7. **`audit_logs` is not immutable:** `ON DELETE CASCADE` deletes audit history if a project or request is removed, and nothing blocks `UPDATE` or `DELETE` statements.

### 2. Architectural & Security Fixes
* **Separate Decision vs. Delivery State:** Keep `approval_requests.status` strictly for the approval lifecycle (`pending | auto_approved | approved | edited_and_approved | rejected | timed_out | cancelled`), and track webhook delivery on `approval_requests.delivery_status` (`not_applicable | pending | delivered | delivery_failed`) plus `webhook_deliveries`.
* **Add Missing Tables:**
  * `users` & `org_memberships` for agency dashboard login and RBAC.
  * `approval_tokens` (`id`, `approval_request_id`, `approver_email`, `token_hash UNIQUE`, `expires_at`, `revoked_at`, `used_at`) for per-approver links and revocation.
  * `approval_votes` (`id`, `approval_request_id`, `approver_email`, `approver_name`, `decision`, `edited_payload JSONB`, `note`, `created_at`, `UNIQUE(approval_request_id, approver_email)`) for multi-approver consensus.
* **Anti-Prefetch Magic-Link Flow:** `GET /review/:token` must be strictly read-only (never auto-approve or consume the token, and only log `viewed` via an explicit client beacon). Render the form with a short-lived, single-use `action_nonce` submitted over `POST`. Optionally require a 6-digit email OTP for high-value policies.
* **Atomic State Transitions & Idempotency:** Use row-level locking (`SELECT ... FOR UPDATE`) when processing votes, timeouts, or cancellations so a human click and a timeout job cannot race. Store `idempotency_request_hash` with `idempotency_key` to return `409 Conflict` on mismatched retries.
* **Policy Snapshots & Fail-Closed Evaluation:** Snapshot the matched policy (`policy_snapshot JSONB`) onto `approval_requests` at creation. If no policy matches, or if a condition fails to parse, default to `require_approval` (fail-closed). Remove `timeout_behavior = 'approve'`.
* **Edit Bounds & Policy Re-Evaluation:** Enforce `editable_schema` (`editable`, types, `min`/`max`) on the server, compute RFC 6902 `diff_payload` server-side, and re-run policy evaluation on `final_payload`. If an edit crosses a stricter threshold, escalate instead of executing. If `required_approvals > 1`, any edit resets prior `approve` votes so all approvers sign off on the exact same `final_payload`.
* **Webhook & Network Safety:** Validate `callback_url` against private/loopback/link-local IP ranges at submission and before DNS resolution in the worker (SSRF protection). Stop retrying early on `400`/`404`/`410` (expired n8n Wait URLs) and only backoff-retry on `429`, `5xx`, or network timeouts. Add `webhook_secret_prev` on `projects` for zero-downtime secret rotation.
* **True Append-Only `audit_logs`:** Replace `ON DELETE CASCADE` with `ON DELETE RESTRICT` (use soft-deletes on projects/requests) and add a PostgreSQL `BEFORE UPDATE OR DELETE` trigger that raises an exception.

### 3. How to Start (Re-Ordered Solo Build)
* **Single TypeScript Monorepo:** Combine Next.js (App Router) + Fastify/Hono API + BullMQ worker sharing Zod schemas and database types with PostgreSQL and Redis, avoiding two separate backend/frontend codebases.
* **Week 1 (Core Engine):** Revised PostgreSQL schema, `POST/GET /v1/approvals`, idempotency hash check, fail-closed policy evaluator, HMAC signer, SSRF validator, and `audit_logs` immutability trigger.
* **Week 2 (Day-1 Wedge):** Anti-prefetch magic-link portal, `editable_schema` form + server-side diffing, email dispatch, BullMQ timeout/retry workers, and a **Zero-Install n8n Template Pack** (copy-pasteable native `HTTP Request` + `Wait` + HMAC `Code` node JSON that works on n8n Cloud and self-hosted). Onboard 2–3 agency design partners on staging.
* **Week 3 (Agency Dashboard & Multi-Approver):** Agency auth, project/API key management, policy rule UI, multi-approver vote tracking, webhook retry inspector, and basic hosted branding (`logo_url`, `accent_color`, path-based `/p/:orgSlug/review/:token`).
* **Week 4 (Hardening & Paid Pilots):** Audit log CSV/JSON export, secret rotation, and Paddle/Lemon Squeezy checkout links.

## Goals vs. Non-Goals

* **In-Scope Goals (v1 / Weeks 1–4):**
  * Deterministic policy engine (`auto_approve`, `require_approval`, `auto_reject`) with fail-closed defaults.
  * Anti-prefetch magic-link web portal with `editable_schema` form rendering, server-side validation, and policy re-evaluation on edit.
  * Multi-approver voting (`approval_votes`) where edits reset prior approvals.
  * Signed webhook callbacks (`X-HITL-Timestamp` + `X-Signature-256`) with SSRF protection and retry visibility.
  * Append-only `audit_logs` with `BEFORE UPDATE OR DELETE` trigger.
  * Zero-install n8n workflow template pack (works on n8n Cloud and self-hosted).
  * Hosted agency branding (`logo_url`, `accent_color`, `Reply-To` email).
* **Out-of-Scope Non-Goals (Deferred to Phase 2+):**
  * Slack OAuth and Block Kit edit modals.
  * TypeScript/Python SDKs (`requestAndWait` long-polling) and `@agentgate/mcp` middleware.
  * Verified `n8n-nodes-agentgate` community npm node.
  * Custom agency domains (`custom_domain` TLS/DNS provisioning) and custom SMTP servers.
  * `timeout_behavior = 'approve'` (fail-open timeouts).

## Alternatives Weighed

* **Build for both agencies and software engineers simultaneously (Original Blueprint):** Rejected because it splits UX and distribution across a white-label portal, Slack modals, SDKs, MCP middleware, and an n8n node in 6 weeks for a solo builder.
* **Lead with `n8n-nodes-agentgate` community node on Day 1:** Rejected because n8n Cloud blocks unverified community nodes; native `HTTP Request` + `Wait` JSON templates work everywhere immediately.
* **Lock the Magic-Link Client Portal behind the $249/mo Agency tier:** Rejected because agencies need to test the client portal during free/trial onboarding before paying $249/mo; gate by project count, branding, and volume instead.
* **Separate NestJS backend + Next.js frontend repos:** Rejected for v1 in favor of a single TypeScript monorepo sharing types and Zod validation schemas.

## Key Decisions & Staging for Next Steps

1. **Day-1 Wedge:** Agencies using n8n + anti-prefetch magic-link web portal; defer Slack, SDKs, and MCP to Phase 2.
2. **Schema & Invariants:** Add `approval_tokens`, `approval_votes`, `users`, `org_memberships`, `policy_snapshot`, separated `delivery_status`, and `audit_logs` immutability triggers before building UI.
3. **Fail-Closed Policy & Edit Rules:** Default to `require_approval`, remove fail-open timeout approvals, validate edits against `editable_schema`, and re-evaluate policies when payloads are edited.
4. **Pricing Gate Adjustment:** Allow agencies to test the magic-link portal in Free/Pro tiers, gating on active client projects, branding, and monthly approval volume.
