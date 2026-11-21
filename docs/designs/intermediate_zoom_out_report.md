# Stage 8: Intermediate Zoom Out Review

**Target Document:** `docs/designs/hitl_approval_layer_design.md` (lines 1–256)  
**Cross-Referenced Reports:** `zoom_out_report.md` (Stage 5), `comprehension_report.md` (Stage 6), `critic_report.md` (Stage 7)  
**Reviewer:** `egm-zoom-out`

---

## Current Standing After Stages 5–7

`docs/designs/hitl_approval_layer_design.md` has **not yet been revised** since Stages 5–7. All YAGNI bloat flagged in Stage 5, all missing/contradictory specifications flagged in Stage 6, and all architectural defects flagged in Stage 7 remain in the document verbatim.

**Core Stage 8 Risk:** If the author applies Stage 7's recommended mitigations *on top of* the uncut Stage 5 architecture, v1 will balloon with accidental complexity (e.g., adding a transactional outbox for Redis/BullMQ, a Next.js BFF proxy for cross-origin Vercel↔Railway auth, and `payload_version` + edit-round caps for multi-approver vote-reset). Making the Stage 5 simplifications **first** eliminates the root causes of several Stage 7 blockers and majors automatically.

---

## Findings

### 1. 🔴 Blocker — Compounding Complexity Trap: Applying Stage 7 Mitigations Without Stage 5 Cuts
* **Affected Scope:** *Technical Plan §1–3* (lines 63–128), *Implementation Plan #1, #6, #8, #9, #10* (lines 180–230), and Stage 7 Recommendations (`critic_report.md` #1, #2, #3, #5).
* **Simplicity Rationale:** Several Stage 7 fixes exist only to patch complexity that v1 does not need:
  * **Outbox + Reconciliation Sweep (`critic_report.md` #2):** Only needed because the design splits state between PostgreSQL and Redis/BullMQ. If v1 drops Redis/BullMQ and runs a simple Postgres-backed poller (or `pg-boss`) against `approval_requests.expires_at` and `webhook_deliveries`, the dual-write boundary disappears.
  * **Next.js BFF Proxy (`critic_report.md` #5):** Only needed because `apps/web` (Vercel) and `apps/api` (Railway/Coolify) are split across two origins. Deploying a single full-stack Next.js app or co-hosting behind one origin eliminates cross-origin Better Auth cookie issues.
  * **`payload_version` + Edit-Round Caps + Grace Windows (`critic_report.md` #1.2, #3):** Only needed because v1 includes multi-approver vote-superseding (CUJ 2). Deferring `required_approvals > 1` to Phase 2 removes the entire edit-convergence state machine.
* **Recommendation:** Decide the Stage 5 cuts *before* Stage 9 so you do not spec and build scaffolding for problems you can delete.

### 2. 🔴 Blocker — Broken Anti-Prefetch Invariant & Undefined Core Contracts Blocking Stage 9
* **Affected Scope:** `approval_tokens.action_nonce_hash` (line 103), `GET` flow (line 116), `policies.conditions` (lines 96, 113), `editable_schema` (lines 25, 100, 189), and `auto_approve`/`auto_reject` (lines 96, 101, 113–114).
* **Simplicity Rationale:** Three core contracts are either broken or missing, making Stage 9 (Implementation Readiness) impossible without guessing:
  1. **Stateful `GET` (`action_nonce_hash`):** Generating and writing `action_nonce_hash` on `GET /v1/review/:token` lets a post-load email scanner or second browser tab overwrite the human's nonce. Keep `GET` 100% read-only; issue a short-lived HMAC-signed `action_nonce` (or a separate `review_nonces` / spent-`jti` check) without mutating `approval_tokens` on `GET`.
  2. **Undefined DSLs (`policies.conditions` and `editable_schema`):** Neither JSON format nor supported operators/field types are defined anywhere in the doc. Define minimal, explicit JSON schemas (and consider reusing Zod/JSON Schema for `editable_schema` instead of a custom validator).
  3. **Undefined `auto_approve` / `auto_reject` vs. n8n `Wait` Node:** Line 114 only specifies `require_approval`, and `approval_requests.status` lacks `auto_rejected`. If `POST /v1/approvals` returns synchronously for `auto_approved`/`auto_rejected` without firing a webhook, an n8n workflow that unconditionally enters `Wait` will hang forever. Explicitly document whether `POST /v1/approvals` returns `status` synchronously and requires an `IF status === 'pending'` node before `Wait` in `templates/n8n/hitl-approval-workflow.json`.

### 3. 🟡 Major — Two-Framework, Two-Host Architecture + Redis/BullMQ Still Uncut
* **Affected Scope:** *Monorepo & Deployment Topology* (lines 63–87), *Workers* (lines 123–126), *Implementation Plan #1, #6, #9* (lines 180–182, 205–207, 220–225).
* **Simplicity Rationale:** Running Next.js 16 (Vercel) + NestJS 12 (Railway/Coolify) + PostgreSQL + Redis/BullMQ for an unvalidated solo-built v1 doubles deployment pipelines, runtime operational surface, and auth complexity. Since `approval_requests.expires_at` and `webhook_deliveries` are already in PostgreSQL, a single deployable app + Postgres-backed job runner eliminates Redis/BullMQ and split-origin CORS/cookie issues in one stroke.

### 4. 🟡 Major — Multi-Approver Consensus & Vote-Superseding State Machine in v1
* **Affected Scope:** *Goals* (line 26), *CUJ 2* (lines 49–53), *Data Model* (lines 103–104), *Core Flows §3.2* (lines 120–122).
* **Simplicity Rationale:** `approval_votes` with partial unique indexes, `superseded_at` invalidation, re-notification loops, and policy re-evaluation on edit are high-complexity features for a v1 whose primary wedge is "n8n workflow pauses for a client to edit/approve a refund or email." Defer `required_approvals > 1` and vote-superseding to Phase 2; in v1, support 1 decision (first valid decision wins).

### 5. 🟡 Major — Unscoped / Half-Specified Features Remaining in v1
* **Affected Scope:**
  * **Paddle/Polar Billing Webhooks:** Line 229 (`projects.controller.ts`) vs. zero mention in *Goals*, *CUJs*, or *Data Model*.
  * **Email OTP (`projects.otp_required`, `POST /v1/review/:token/otp`):** Still listed as an *Open Question* (line 39) while hardcoded into lines 94, 176, 218, 225, 237 with no OTP table/columns, TTL, or attempt limits—and emailing an OTP to the same inbox as the magic link adds friction with minimal security gain.
  * **`timeout_behavior = 'escalate'`:** Still in lines 96 and 124 with no `escalation_emails` column, no `escalated` status, and no worker behavior.
  * **Dual-Secret Rotation & Envelope Encryption (`webhook_secret_enc` + `webhook_secret_prev_enc`):** Still in lines 94, 128, 165, 207, 229, forcing the v1 n8n `Code` node template to handle dual-key verification.
* **Simplicity Rationale:** Cut billing webhooks, email OTP, `'escalate'`, and dual-secret rotation from v1. Keep a single `webhook_secret` (regeneratable on compromise) and strictly fail-closed `timed_out` timeouts.

### 6. 🟡 Major — Calibrating Stage 7 Additions (Keep Essential Safety, Avoid Spec Bloat)
* **Affected Scope:** `critic_report.md` #7, #8, #11.
* **Simplicity Rationale:** When incorporating Stage 7 feedback before Stage 9, keep the minimal high-leverage fixes and avoid over-engineering the rest:
  * **Keep:** SSRF redirect-blocking (`redirect: 'manual'`, reject `3xx`) + resolved-IP pinning; bounded payload/response sizes (e.g., `64KB`–`256KB` request payload, `4KB` `response_body` truncation); and `<= 5 min` timestamp skew + `timingSafeEqual` in the n8n `Code` node.
  * **Keep Lean:** Do **not** build a full GDPR erasure/anonymization pipeline or elaborate observability/alerting infrastructure specs for v1—simply note PII retention/anonymization as a Phase 2 operational concern and rely on standard structured logs + `webhook_deliveries` inspection.

### 7. 🟢 Nit — Remaining Premature Artifacts, Dead States, and Naming Drift
* **Affected Scope:**
  * `packages/sdk` *(reserved for Phase 2)* (line 71): Do not scaffold empty Phase 2 packages in v1.
  * `approval_requests.status = 'cancelled'` (line 101): Never referenced in any flow or endpoint; remove or add a cancel endpoint.
  * `POST /v1/review/:token/viewed` beacon (lines 116, 217, 237), RFC 6902 `diff_payload` (when `original_payload` and `final_payload` are already stored), and CSV/JSON export + retry inspector UI (lines 67, 229, 241): Low-value polish for initial validation; consider cutting or marking optional.
  * Package naming (`@agentgate/*` on lines 32–33, 71 vs. `@hitl/*` on lines 250, 252) and stale references (`"original blueprint"` on lines 91, 132; `"Reliability-First"` marketing phrasing; `Rollout & Rollback` heading on line 170 with no rollback steps).

---

## Pre-Stage 9 Readiness Checklist

Before moving to Stage 9 (Implementation Readiness), update `docs/designs/hitl_approval_layer_design.md` to:
1. **Apply the v1 cuts** (or explicitly justify keeping any of: Next.js+NestJS split, Redis/BullMQ, multi-approver vote-superseding, billing webhooks, email OTP, `escalate`, dual-secret rotation).
2. **Fix the `GET` `action_nonce` invariant** so `GET` never mutates `approval_tokens`.
3. **Define the missing contracts:** `policies.conditions` JSON format, `editable_schema` format, and synchronous `auto_approved`/`auto_rejected` handling in `POST /v1/approvals` + n8n `IF` node.
4. **Apply the lean Stage 7 safety fixes:** SSRF redirect blocking + IP pinning, payload/response size caps, and `<= 5 min` HMAC timestamp skew check.
