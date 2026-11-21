# Stage 6: Comprehension Test

**Target Document:** `docs/designs/hitl_approval_layer_design.md`  
**Reviewer:** `egm-comprehension`

---

## What this proposes
This document proposes a v1 Human-in-the-Loop (HITL) approval service built as a TypeScript monorepo (`apps/web` in Next.js 16, `apps/api` in NestJS 12 with BullMQ, and `packages/shared` + `packages/db` using Drizzle ORM, PostgreSQL, and Redis) aimed at AI automation agencies using n8n. When an n8n workflow submits an action to `POST /v1/approvals`, the service evaluates deterministic policy rules (failing closed to `require_approval` on no-match or parse errors), schedules a BullMQ timeout job, and emails per-approver magic links to a branded read-only web portal (`/p/:orgSlug/review/:token`). Reviewers can inspect and edit allowed fields against `editable_schema` (with server-side bounds validation, RFC 6902 diffing, policy re-evaluation, and multi-approver vote reset on edits), submit decisions via `POST` protected by a single-use `action_nonce` and optional email OTP, and trigger an HMAC-SHA256-signed webhook to resume the n8n Wait node while recording immutable `audit_logs`. The detailed implementation plan (lines 174–256) specifies 14 file/module groups across monorepo configuration, shared validation/SSRF/policy logic, Drizzle schema and SQL immutability triggers, NestJS API endpoints and BullMQ workers, Next.js review/admin UIs, n8n workflow templates, and a turbo/unit/lint/E2E verification plan.

## How the existing system works, per this document
Per this document, there is no existing codebase or legacy production data yet (this is a greenfield v1 implementation). Currently, AI automation agencies rely on native n8n Slack/email wait nodes or custom DIY approval scripts, which only support binary approve/reject without edit-before-execute, expose `GET`-based webhook links to email security scanner pre-fetches without per-approver attribution or quorum tracking, and lack deterministic policy guardrails, fail-closed timeouts, and append-only audit trails.

---

### Findings

1. **Severity**: 🟡 Major
   **Affected Scope**: `policies.timeout_behavior` (`escalate`), `approval_requests.status`, and `timeout.processor.ts` (lines 96, 101, 124, 223)
   **Discrepancy Description & Rationale**: `policies.timeout_behavior` allows `reject | escalate` (line 96), and line 124 states the timeout job "transitions to `timed_out` (or escalates)". However, `approval_requests.status` (line 101) has no `escalated` state, `timeout.processor.ts` (line 223) only mentions transitioning to `timed_out`, and the document never defines what `escalate` actually does (e.g., whether it notifies a fallback admin, extends `expires_at`, or still fires the webhook with `timed_out`).

2. **Severity**: 🟡 Major
   **Affected Scope**: `policies.decision_mode` (`auto_approve` / `auto_reject`) and `POST /v1/approvals` ingestion flow (lines 96, 101, 113–114)
   **Discrepancy Description & Rationale**: Line 96 defines `decision_mode` as `auto_approve | require_approval | auto_reject`, and line 101 includes `auto_approved` in `approval_requests.status` (with no `auto_rejected` status). Line 114 only specifies the `require_approval` path. It is unstated whether `auto_approve` and `auto_reject` create `approval_requests`/`audit_logs` rows, whether they return the decision synchronously in `POST /v1/approvals`, and whether they also fire the `callback_url` webhook (which an n8n `Wait` node would expect if it always pauses after `HTTP Request`).

3. **Severity**: 🟡 Major
   **Affected Scope**: `action_nonce` / `action_nonce_hash` anti-prefetch mechanics (lines 24, 103, 116–117, 216)
   **Discrepancy Description & Rationale**: `approval_tokens` stores `action_nonce_hash` (line 103), and line 116 states `GET /p/:orgSlug/review/:token` fetches a single-use `action_nonce` from `apps/api` without mutating `status` or consuming the token. If `GET /v1/review/:token` generates and persists `action_nonce_hash` in `approval_tokens`, then a security scanner pre-fetching the `GET` URL after (or concurrently with) the human opening it would overwrite `action_nonce_hash` and invalidate the human's nonce. Conversely, if `action_nonce` is stateless or stored elsewhere, `action_nonce_hash` in `approval_tokens` is unexplained.

4. **Severity**: 🟡 Major
   **Affected Scope**: Optional Email OTP flow, `POST /v1/review/:token/otp`, and Open Questions (lines 39, 176, 218, 225)
   **Discrepancy Description & Rationale**: Line 39 lists whether email OTP is per-policy or per-project as an Open Question, while line 176 resolves it as a project-level toggle (`projects.otp_required`), leaving the Open Questions section stale. Additionally, the mechanics of `POST /v1/review/:token/otp` (line 218) are undefined: it is unclear whether this endpoint requests/sends an OTP or verifies it, where OTP codes/TTLs/attempt limits are stored (no OTP column or table exists in Section 2), and how it interacts with `POST /v1/review/:token/decide`.

5. **Severity**: 🟡 Major
   **Affected Scope**: `editable_schema` and `policies.conditions` formats (lines 25, 46, 96, 100, 113, 188–189)
   **Discrepancy Description & Rationale**: Both `editable_schema` (referencing `editable: true/false`, `types`, `min`/`max`/`maxLength`) and `policies.conditions JSONB` (referencing condition parsing and `priority ASC` matching) are core contracts, yet neither DSL/schema structure is defined or illustrated anywhere in the document. An implementer cannot build `policy-evaluator.ts` or `editable-schema.ts` without knowing the exact JSON structure and supported operators.

6. **Severity**: 🟡 Major
   **Affected Scope**: Paddle/Polar billing webhooks and pricing tiers (lines 93, 144–148, 229)
   **Discrepancy Description & Rationale**: Line 229 adds "handling Paddle/Polar billing webhooks" to `apps/api/src/dashboard/projects.controller.ts`, and lines 93 and 144–148 reference `organizations.plan` and pricing tiers (`Free`, `Pro`, `$249/mo`). However, billing, subscription state, plan quotas/enforcement, and Paddle/Polar integration are not mentioned in Goals, Non-Goals, CUJs, Data Model, or NFRs, leaving their requirements and data flow completely unspecified.

7. **Severity**: 🟢 Nit
   **Affected Scope**: Workspace package naming (`@agentgate/*` vs. `@hitl/*`) (lines 32–33, 71, 250, 252)
   **Discrepancy Description & Rationale**: Lines 32, 33, and 71 use the `@agentgate/mcp` / `n8n-nodes-agentgate` naming, whereas the Verification Plan (lines 250, 252) uses `@hitl/shared` and `@hitl/api`. Standardizing the package scope avoids confusion.

8. **Severity**: 🟢 Nit
   **Affected Scope**: References to "the original blueprint" (lines 91, 132)
   **Discrepancy Description & Rationale**: Lines 91 and 132 reference "the original blueprint" without a link or brief summary, assuming prior historical context for a new reader (though Alternative A provides partial context).

9. **Severity**: 🟢 Nit
   **Affected Scope**: `GET /v1/approvals` and `GET /v1/approvals/:id` authentication (line 211)
   **Discrepancy Description & Rationale**: Line 211 states `GET /v1/approvals/:id` and `GET /v1/approvals` are "for dashboard and polling" without specifying whether they accept API key auth (`hk_live_...`), Better Auth session auth, or both.
