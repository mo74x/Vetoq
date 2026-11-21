# Stage 7: Critic Review

**Target Document:** `docs/designs/hitl_approval_layer_design.md` (`FeatureRange`: lines 1–173)  
**Reviewers:** `egm-design`, `egm-structural`, `egm-style`

---

## Part 1: Design Critic (`egm-design`)

### 🔴 Blockers

1. **Broken `action_nonce` & Token Lifecycle Under Prefetching and Multi-Approver Edit Resets**
   * **Affected Scope:** `approval_tokens` (line 103), CUJ 2 (lines 49–53), Flow 2 (lines 115–122)
   * **Finding:**
     1. **Prefetch clobbering:** `GET /p/:orgSlug/review/:token` generates a single-use `action_nonce` stored as `action_nonce_hash` on `approval_tokens`. If an email security scanner or browser prefetch hits `GET` *after* the human loads the page (or if the user opens two tabs), `action_nonce_hash` is overwritten, invalidating the human's active form submission.
     2. **Edit-reset re-voting:** In CUJ 2, when Approver B edits the payload, Approver A's prior vote is marked `superseded_at` and Approver A is notified to re-confirm. However, it is unspecified whether `used_at` is set on the first vote.
   * **Recommendation:** Store nonces separately (e.g., short-lived signed/HMAC'd `action_nonce` bound to `(token_id, payload_version, exp)` or a multi-row `review_nonces` table) rather than a single mutable `action_nonce_hash` column on `approval_tokens`. Bind votes/tokens to a monotonic `payload_version` counter on `approval_requests` or issue fresh tokens on re-notification.

2. **No Transactional Outbox Between PostgreSQL and BullMQ (Violates Fail-Closed SLA)**
   * **Affected Scope:** Flow 1 (line 114), Flow 2 (line 122), Flow 3 (line 124)
   * **Finding:** Dual writes (committing state changes to PostgreSQL and then enqueueing/cancelling BullMQ jobs in Redis) mean a process crash or Redis outage after the PostgreSQL commit silently drops timeout or webhook delivery jobs.
   * **Recommendation:** Introduce a PostgreSQL transactional outbox table (written inside the same DB transaction) or a periodic DB reconciliation sweep for `pending` rows past `expires_at` and `delivery_status = 'pending'` rows.

### 🟡 Majors

3. **Incomplete Policy Re-Evaluation Semantics on Edit**
   * **Affected Scope:** `approval_requests` (lines 97–102), Flow 2 (line 120)
   * **Finding:** Mutating `policy_snapshot` in-place destroys the creation-time audit record; outcomes for `auto_reject`, `auto_approve`, or changed `approver_emails` / `timeout_seconds` on edit are undefined; `required_approvals` is missing from `approval_requests`.
   * **Recommendation:** Keep `initial_policy_snapshot` immutable, record transitions in `audit_logs`, define `auto_reject`/`auto_approve`/approver changes on edit, and add `required_approvals` and `payload_version` to `approval_requests`.

4. **`timeout_behavior = 'escalate'` Is Unspecified Across Schema and Flows**
   * **Affected Scope:** `policies` (line 96), `approval_requests` (line 101), Flow 3 (line 124)
   * **Finding:** No `escalation_emails` column, no `escalated` status, and no escalation SLA/n8n interaction.
   * **Recommendation:** Either fully specify escalation or remove `'escalate'` from v1.

5. **Cross-Domain Auth, CORS, and Public Endpoint Rate-Limiting Gaps**
   * **Affected Scope:** Monorepo & Deployment Topology (lines 67–68, 82–86), Flow 2 (line 117), NFRs (lines 164–167)
   * **Finding:** Cross-origin Better Auth cookies between Vercel (`apps/web`) and Railway/Hetzner (`apps/api`) are blocked by third-party cookie restrictions; `/v1/review/:token/decide` and 6-digit OTPs lack rate limiting and attempt caps.
   * **Recommendation:** Route dashboard API calls through a Next.js BFF/proxy (or signed token exchange) and add IP + per-token rate limiting and max failed OTP attempts.

6. **n8n Synchronous `auto_approved` / `auto_rejected` vs. `Wait` Node Race**
   * **Affected Scope:** Flow 1 (lines 113–114), Flow 4 (line 128)
   * **Finding:** If `POST /v1/approvals` returns `auto_approved` or `auto_rejected` synchronously, an n8n workflow that unconditionally enters `Wait` will hang indefinitely.
   * **Recommendation:** Require an `IF` node in the n8n template checking `status === 'pending'` before entering `Wait`.

7. **DNS-Rebinding TOCTOU & HTTP Redirect Bypass in SSRF Protection**
   * **Affected Scope:** Flow 1 (line 111), Flow 3 (line 125), NFRs (line 166)
   * **Finding:** Re-validating DNS before calling an HTTP client has a TOCTOU window, and following `3xx` redirects can hit `169.254.169.254`.
   * **Recommendation:** Pin the validated IP in a custom HTTP agent `lookup` hook and disable redirects (`redirect: 'manual'`, rejecting `3xx`).

8. **Unbounded Payload Sizes & GDPR/Erasure Conflict on `audit_logs`**
   * **Affected Scope:** Data Model (lines 100, 105–106), NFRs (lines 164–172)
   * **Finding:** No size limits on `original_payload`, `editable_schema`, or `webhook_deliveries.response_body`; `ON DELETE RESTRICT` + immutability trigger prevents tenant PII erasure.
   * **Recommendation:** Enforce payload size limits (e.g., 64KB–256KB), truncate `response_body` (e.g., 4KB), and document PII anonymization/retention handling.

### 🟢 Nits
* **9.** Tight DNS timeout or async-only DNS check to protect `< 150ms` p95 ingestion latency.
* **10.** Specify timestamp skew check (`<= 5 minutes`) + `timingSafeEqual` in the n8n `Code` node, and version encrypted secrets (`v1:...`).
* **11.** Add an Observability & Alerting subsection under NFRs.

---

## Part 2: Structural Validator (`egm-structural`)

1. **🟡 Major — Missing `required_approvals` column & `policy_snapshot` mutability contradiction** (Lines 97–102 vs. Line 120).
2. **🟡 Major — Undefined `escalate` timeout behavior and missing schema/state support** (Lines 96, 101, 124).
3. **🟢 Nit — Misleading arrow target for `POST /v1/review/:token/decide` in architecture diagram** (Lines 82–86).
4. **🟢 Nit — `Open Questions` asymmetry with `projects.otp_required`** (Line 39 vs. Line 94).
5. **🟢 Nit — Unreferenced `cancelled` state in `approval_requests.status`** (Line 101 vs. Lines 108–128).

---

## Part 3: Technical Copy Editor (`egm-style`)

### 🟡 Majors
1. **Unexplained External Reference & Vague Phrasing** (Line 91): Remove `"and resolve the gaps from the original blueprint"`.
2. **Startup/Marketing Jargon** (Line 136): Replace `"buyer loops"` and `"primary agency wedge"` with plain English.
3. **Precision Contradiction on SSRF / DNS-Rebinding Check** (Line 166 vs. Line 125): Line 166 says `"immediately before DNS resolution"`, whereas DNS-rebinding protection checks `"immediately after DNS resolution and before connecting"`.
4. **Uncalibrated Section Heading (`CALIBRATE`)** (Lines 170–172): `Rollout & Rollback` has no rollback procedure; rename to `Rollout & Migrations` or add rollback steps.

### 🟢 Nits
1. Remove promotional label `"Reliability-First"` from title (Line 1) and Line 160.
2. Replace `"on Day 1"` / `"from day one"` with `"at v1 launch"` and `"copy-pasteable"` with `"importable"` (Lines 23, 134, 138, 141, 142).
3. Replace `"futile"` with `"further"` (Line 59).
4. Replace `"pure TypeScript monorepo"` with `"a TypeScript monorepo"` (Line 65).
5. Replace `"zero-downtime secret rotation"` with `"dual-key secret rotation without invalidating in-flight webhooks"` (Lines 94, 165).
6. Replace `"sign off on"` with `"approve"` (Line 121).
7. Replace `"Slightly cleaner"` with factual node-count wording (Line 140).
8. Drop redundant `"Rejected by author:"` prefix in `Reason for Rejection:` bullets and replace `"primary agency hook"` with `"magic-link client portal"` (Lines 136–160).
9. Replace `"never blocks"` with `"does not block"` and `"sub-150ms"` with `"< 150 ms"` (Line 169).
