# Stage 5: Initial Zoom Out Review

**Target Document:** `docs/designs/hitl_approval_layer_design.md` (lines 1–256)  
**Reviewers:** `egm-zoom-out`, `egm-inventive-catalyst`

---

## Part 1: Zoom Out (`egm-zoom-out`)

### Executive Summary
The core value proposition—a fail-closed, anti-prefetch magic-link approval layer with edit-before-execute for n8n workflows—is clear and well-motivated. However, for an unvalidated **v1** built by a solo developer, the design carries substantial **YAGNI and operational bloat**: two separate backend/frontend frameworks deployed on separate hosts, Redis + BullMQ infrastructure, a multi-approver vote-superseding state machine, dual-secret envelope encryption rotation, email OTPs, and unmotivated billing webhooks. Stripping these out can cut v1 complexity roughly in half without losing the core n8n + magic-link wedge.

### Findings

1. **🟡 Major — Two-Framework, Two-Host Architecture + Redis/BullMQ Overhead**
   * **Affected Scope:** *Technical Plan §1 (Monorepo & Deployment Topology)*, lines 63–87; *§3.3 (Workers)*, lines 123–126; *Detailed Implementation Plan #1, #6, #9*, lines 180–182, 205–207, 220–225.
   * **Simplicity Rationale:** Running **Next.js 16** (Vercel) *and* **NestJS 12** (Railway/Coolify) plus **PostgreSQL + Redis (BullMQ)** introduces two separate runtimes, two deployment pipelines, cross-service Better Auth session validation, and a Turborepo build graph just to share Zod schemas.
   * **Simplification:** Consolidate `apps/web` and `apps/api` into a single full-stack Next.js app (or a single NestJS/Fastify API + lightweight React SPA) for v1. Furthermore, since `webhook_deliveries` and `approval_requests.expires_at` already live in PostgreSQL, a simple Postgres-backed job poller (or `pg-boss`) removes **Redis + BullMQ** as an entire infrastructure dependency in v1.

2. **🟡 Major — Multi-Approver Consensus & Vote-Superseding State Machine in v1**
   * **Affected Scope:** *Goals*, line 26; *CUJ 2*, lines 49–53; *Data Model (`approval_tokens`, `approval_votes`)*, lines 103–104; *Core Flows §3.2*, lines 121–122.
   * **Simplicity Rationale:** Tracking per-approver votes, partial unique indexes (`WHERE superseded_at IS NULL`), invalidating prior `approve` votes when a subsequent reviewer edits the payload, and re-notifying prior approvers is a complex distributed state machine. For v1 agency validation (where a single client stakeholder typically approves a refund or email), this is premature complexity.
   * **Simplification:** Defer `required_approvals > 1` and `approval_votes` superseding to Phase 2. In v1, support `1` required approval (optionally emailing multiple configured reviewers where the first valid decision resolves the request).

3. **🟡 Major — Unscoped & Contradictory Features: Billing Webhooks and Email OTP**
   * **Affected Scope:** *Open Questions*, line 39; *Data Model (`projects.otp_required`)*, line 94; *Detailed Implementation Plan*, lines 176, 218, 229, 237.
   * **Simplicity Rationale:**
     * **Paddle/Polar billing webhooks** appear in *Implementation Plan #10* (line 229) with zero mention in *Overview*, *Goals*, *CUJs*, or *Data Model* (there is no `subscriptions` or `billing` table). Integrating payment webhooks before validating the product is pure YAGNI.
     * **6-digit Email OTP** is listed as an unresolved *Open Question* (line 39), yet the implementation plan already hardcodes `projects.otp_required` and `POST /v1/review/:token/otp`. Worse, emailing an OTP to the *same inbox* that just received the magic link adds UX friction and extra endpoints/emails without meaningful security gain over `POST`-only + `action_nonce`.
   * **Simplification:** Cut both billing webhooks and email OTP from v1. Handle early agency plans manually in `organizations.plan` until demand is proven.

4. **🟡 Major — Underspecified `timeout_behavior = 'escalate'` Branch**
   * **Affected Scope:** *Data Model (`policies`)*, line 96; *Core Flows §3.3*, line 124; *Implementation Plan #9*, line 223.
   * **Simplicity Rationale:** `policies.timeout_behavior` allows `'reject' | 'escalate'`, and line 124 mentions `"transitions to timed_out (or escalates)"`, yet `policies` has no escalation target (e.g., `escalation_emails`), no CUJ covers escalation, and `timeout.processor.ts` (line 223) only transitions to `timed_out`. Leaving a dead/half-defined enum branch creates ambiguity and wasted code.
   * **Simplification:** Remove `'escalate'` in v1; keep timeouts strictly fail-closed (`timed_out` -> webhook/reject).

5. **🟡 Major — Dual-Secret Rotation & Envelope Encryption in v1**
   * **Affected Scope:** *Data Model (`projects`)*, line 94; *Core Flows §3.4*, line 128; *NFRs*, line 165; *Implementation Plan #6, #10*, lines 207, 229.
   * **Simplicity Rationale:** Implementing AES-256-GCM envelope encryption (`APP_ENCRYPTION_KEY`) plus zero-downtime dual-secret rotation (`webhook_secret_enc` + `webhook_secret_prev_enc`)—and requiring the "copy-pasteable" n8n `Code` node template to verify against both secrets—adds unnecessary ceremony for v1.
   * **Simplification:** Store a single `webhook_secret` in v1 and allow regenerating it if compromised. Add dual-secret rotation only when enterprise customers require zero-downtime key rotation.

6. **🟢 Nit — Speculative / Premature Artifacts & Telemetry**
   * **Affected Scope:** *Monorepo Topology (`packages/sdk`)*, line 71; *RFC 6902 Diffing*, lines 25, 69, 120, 189; *Client `viewed` Beacon*, lines 116, 217, 237; *Audit CSV/JSON Export & Webhook Retry Inspector*, lines 67, 229, 241.
   * **Simplicity Rationale:**
     * `packages/sdk` *(reserved for Phase 2)* should not be scaffolded in v1.
     * Because `original_payload` and `final_payload` are both stored on `approval_requests`, computing RFC 6902 JSON Patch diffs (`diff_payload`) is redundant for v1 unless an external consumer specifically requires RFC 6902 format.
     * A dedicated `POST /v1/review/:token/viewed` beacon endpoint and dashboard CSV/JSON export + webhook retry inspector UI are low-value polish items that can wait until after initial agency onboarding.
     * Consider using standard JSON Schema (e.g., `ajv`) for `editable_schema` validation rather than building a custom `editable-schema.ts` validator from scratch.

---

## Part 2: Inventive Catalyst (`egm-inventive-catalyst`)

1. **🔴 Blocker — Stateful `GET` Overwrites `action_nonce_hash` (Anti-Prefetch Invariant Violation)**
   * **Affected Scope:** Core Flows §2 (*Anti-Prefetch Magic-Link Decision*, lines 115–116) & Data Model (`approval_tokens`, line 103).
   * **False Compromise:** The design separates `GET` (display) from `POST` (decide) to defeat email security scanners, yet stores a single `action_nonce_hash` column on `approval_tokens` generated during `GET /v1/review/:token`. Because `GET` writes a new `action_nonce_hash`, **`GET` is still stateful**. If an email scanner (Defender Safe Links, Mimecast) prefetches the link *after* the human opens the page—or if the reviewer opens the link in two tabs—the second `GET` silently overwrites `action_nonce_hash` and breaks the human's `POST /v1/review/:token/decide` submission.
   * **Proposed Resolution:** Keep `GET` 100% pure and stateless by decoupling nonce issuance from `GET`:
     * *Option A (Stateless Signed Nonce):* Mint a short-lived HMAC/JWT `action_nonce` bound to `token_hash` + `jti` + expiry on `GET` without writing to PostgreSQL; record the `jti` in a spent-nonce cache/table only upon `POST` consumption.
     * *Option B (Client-Hydrated Session Nonce):* Issue the `action_nonce` via an explicit client-side `POST /v1/review/:token/session` after JS hydration.
   * **Secondary Liabilities:** Option A requires a small spent-`jti` store (TTL = nonce lifetime) to enforce single-use; Option B adds one extra client round-trip on page hydration.

2. **🟡 Major — Dual-Write Gap Between PostgreSQL State and BullMQ Jobs**
   * **Affected Scope:** Core Flows §2–3 (lines 114, 122–126) & Workers (`timeout.processor.ts`, `webhook.processor.ts`, lines 220–225).
   * **False Compromise:** The design commits the `approval_requests.status` transition and `audit_logs` write in PostgreSQL, and *then* cancels the BullMQ timeout job and enqueues the BullMQ webhook delivery job in Redis. Accepting this non-atomic boundary means a process crash or transient Redis failure after the PostgreSQL commit leaves the request `approved` in the database while **never delivering the webhook**—permanently stranding the waiting n8n execution.
   * **Proposed Resolution:** Insert the initial `webhook_deliveries` row (`status = 'pending'`) inside the **same PostgreSQL transaction** that transitions `approval_requests.status`. Enqueueing to BullMQ becomes an optimization, backed by a lightweight periodic sweep that picks up any `pending` `webhook_deliveries` older than a few seconds.
   * **Secondary Liabilities:** Adds one extra row insert per terminal decision and a simple periodic reconciliation query against `webhook_deliveries`.

3. **🟡 Major — Multi-Approver Edit Reset vs. Convergence & Timeout Starvation**
   * **Affected Scope:** CUJ 2 (lines 49–53) & Core Flows §2 (lines 120–122).
   * **False Compromise:** To guarantee all approvers sign off on the exact same `final_payload`, any edit marks all prior `approval_votes` as `superseded_at = NOW()` and resets progress toward `required_approvals`. However, `expires_at` remains fixed from creation and edits are unbounded. Two approvers can ping-pong edits indefinitely until the SLA expires (`timed_out`), or an edit near `expires_at` can leave zero time for prior approvers to re-confirm. Additionally, line 120 only addresses edits that trigger a *stricter* policy, leaving policy-relaxation edits (e.g., editing `$600` down to `$40`) unaddressed.
   * **Proposed Resolution:** Cap edit rounds per request (or lock `editable_schema` after the first edit/vote unless escalated), and/or grant a bounded dynamic grace extension to `expires_at` (within a hard max TTL) when an edit supersedes existing votes. Explicitly define policy re-evaluation symmetry: lock `required_approvals` to `max(initial, edited)` (monotonic safety).
   * **Secondary Liabilities:** Introduces an extra state/counter (`edit_count` or `max_expires_at`) and requires communicating the grace window or edit-lock clearly in the review UI.

4. **🟡 Major — Split-Origin Deployment Topology (`apps/web` on Vercel + `apps/api` on Railway/Hetzner)**
   * **Affected Scope:** Monorepo & Deployment Topology (lines 63–87).
   * **False Compromise:** Splitting runtime origins across Vercel (`apps/web`) and Railway/Coolify (`apps/api`) forces cross-origin CORS configuration, complicates Better Auth session/cookie sharing between domains, and adds an extra public network hop (`Browser -> Vercel -> Railway -> Postgres`).
   * **Proposed Resolution:** Serve both `apps/web` and `apps/api` behind a single origin/reverse proxy (e.g., co-hosting both containers on Hetzner/Coolify behind Caddy/Traefik, or routing `/v1/*` and `/api/auth/*` through a single domain gateway) so the browser only ever communicates with one origin.
   * **Secondary Liabilities:** Co-hosting `apps/web` on Coolify/Hetzner trades away Vercel's zero-config edge CDN for static assets (mitigable with Cloudflare in front); proxying via Vercel rewrites subjects API calls to Vercel's serverless timeout limits.

5. **🟢 Nit — Project-Wide `otp_required` Toggle vs. Risk-Based Step-Up**
   * **Affected Scope:** Open Questions (line 39) & Detailed Implementation Plan (line 176).
   * **False Compromise:** Making `projects.otp_required` a binary project-level toggle forces a false choice between frictionless UX on low-risk approvals and strong step-up authentication on high-value financial actions.
   * **Proposed Resolution:** Move `require_otp` onto `policies` (with `projects.otp_required` as the default fallback).
   * **Secondary Liabilities:** Adds one boolean field to the policy builder UI and requires triggering OTP verification if an edit escalates the request to a policy with `require_otp = true`.
